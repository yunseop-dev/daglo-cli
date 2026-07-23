import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { DagloApiClient } from "../api/client.js";
import { logger } from "../logger.js";
import { TranscribeArgs } from "../schemas/transcribe.js";

const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024; // 500MB (server-enforced; CLI warns only)

interface WorkspaceHeaders {
  [key: string]: string;
  "daglo-workspace-id": string;
  platform: string;
}

interface CreateFileResponse {
  fileId: string;
  fileMeta: { id: string };
  signedUrl: string;
}

interface FinalizeResponse {
  id: string;
  size?: number;
  mimetype?: string;
  duration?: number;
}

interface UserTranscriptionOption {
  language?: string;
  topic?: string;
  useSpeakerDiarization?: boolean;
  useDictionary?: boolean;
}

export interface TranscribeFileResult {
  name: string;
  fileMetaId: string;
  fileId: string;
  duration?: number;
  size?: number;
}

export interface TranscribeResult {
  boardId?: string;
  fileMetaIds: string[];
  files: TranscribeFileResult[];
  options: Required<UserTranscriptionOption>;
}

/** Resolve the default workspace UUID required by the transcription endpoints. */
const resolveWorkspaceId = async (client: DagloApiClient): Promise<string> => {
  const response = await client.request("/workspaces", {
    headers: { platform: "web" },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch workspaces: ${response.statusText}`);
  }

  const workspaces = (await response.json()) as Array<{
    id?: string;
    isDefault?: boolean;
  }>;
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    throw new Error("No workspaces available for this account.");
  }

  const chosen = workspaces.find((w) => w.isDefault) ?? workspaces[0];
  if (!chosen?.id) {
    throw new Error("Could not determine workspace id.");
  }
  return chosen.id;
};

/** Fetch the account's saved transcription defaults. */
const fetchUserTranscriptionOption = async (
  client: DagloApiClient,
  headers: WorkspaceHeaders
): Promise<UserTranscriptionOption> => {
  const response = await client.request("/user-option/transcription", {
    headers,
  });
  if (!response.ok) return {};
  try {
    return (await response.json()) as UserTranscriptionOption;
  } catch {
    return {};
  }
};

/** Step 1: create a file slot and obtain a GCS resumable signed URL. */
const createFileSlot = async (
  client: DagloApiClient,
  headers: WorkspaceHeaders,
  name: string
): Promise<CreateFileResponse> => {
  const response = await client.request("/files", {
    method: "POST",
    headers,
    body: JSON.stringify({ name, uploadType: "FILE" }),
  });
  if (!response.ok) {
    throw new Error(`Failed to create file slot for "${name}": ${response.statusText}`);
  }
  return (await response.json()) as CreateFileResponse;
};

/**
 * Steps 2-3: upload bytes to GCS via a resumable session.
 * Uses raw fetch (no Authorization / JSON headers) — the signed URL carries auth
 * and the signature only covers host + x-goog-resumable.
 */
const uploadToGcs = async (signedUrl: string, filePath: string): Promise<void> => {
  const startResponse = await fetch(signedUrl, {
    method: "POST",
    headers: {
      "x-goog-resumable": "start",
      "content-type": "application/octet-stream",
    },
  });
  if (startResponse.status !== 201) {
    throw new Error(
      `Failed to start GCS upload session: ${startResponse.status} ${startResponse.statusText}`
    );
  }

  const sessionUri = startResponse.headers.get("location");
  if (!sessionUri) {
    throw new Error("GCS upload session did not return a Location header.");
  }

  const body = readFileSync(filePath);
  const putResponse = await fetch(sessionUri, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body,
  });
  if (!putResponse.ok) {
    throw new Error(
      `Failed to upload file bytes to GCS: ${putResponse.status} ${putResponse.statusText}`
    );
  }
};

/** Step 4: finalize the upload so the backend reads size/duration from GCS. */
const finalizeUpload = async (
  client: DagloApiClient,
  headers: WorkspaceHeaders,
  fileMetaId: string
): Promise<FinalizeResponse> => {
  const response = await client.request("/file/metadata", {
    method: "POST",
    headers,
    body: JSON.stringify({ fileMetaId }),
  });
  if (!response.ok) {
    throw new Error(`Failed to finalize upload: ${response.statusText}`);
  }
  return (await response.json()) as FinalizeResponse;
};

/** Step 5: trigger transcription for all uploaded files. */
const requestTranscription = async (
  client: DagloApiClient,
  headers: WorkspaceHeaders,
  fileMetaIds: string[],
  options: Required<UserTranscriptionOption>
): Promise<void> => {
  const response = await client.request("/transcript-request", {
    method: "POST",
    headers,
    body: JSON.stringify({
      language: options.language,
      useSpeakerDiarization: options.useSpeakerDiarization,
      topic: options.topic,
      useDictionary: options.useDictionary,
      fileMetaIds,
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to request transcription: ${response.statusText}`);
  }
};

/** Best-effort: find the board that was just created for one of the fileMetaIds. */
const findBoardId = async (
  client: DagloApiClient,
  headers: WorkspaceHeaders,
  fileMetaIds: string[],
  limit: number
): Promise<string | undefined> => {
  try {
    const response = await client.request(
      `/v2/boards?page=1&limit=${limit}&sort=createTime.desc`,
      { headers }
    );
    if (!response.ok) return undefined;

    const payload = (await response.json()) as unknown;
    const items = extractBoardItems(payload);
    const target = new Set(fileMetaIds);

    for (const board of items) {
      const boardMetaIds = extractFileMetaIds(board);
      if (boardMetaIds.some((id) => target.has(id))) {
        return typeof board.id === "string" ? board.id : undefined;
      }
    }
  } catch {
    // best-effort only
  }
  return undefined;
};

const extractBoardItems = (payload: unknown): Array<Record<string, unknown>> => {
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const key of ["items", "data", "boards", "results"]) {
      if (Array.isArray(obj[key])) return obj[key] as Array<Record<string, unknown>>;
    }
  }
  return [];
};

const extractFileMetaIds = (board: Record<string, unknown>): string[] => {
  const ids: string[] = [];
  if (typeof board.fileMetaId === "string") ids.push(board.fileMetaId);
  const fileMeta = board.fileMeta;
  if (Array.isArray(fileMeta)) {
    for (const fm of fileMeta) {
      if (fm && typeof fm === "object" && typeof (fm as { id?: unknown }).id === "string") {
        ids.push((fm as { id: string }).id);
      }
    }
  } else if (fileMeta && typeof fileMeta === "object") {
    const id = (fileMeta as { id?: unknown }).id;
    if (typeof id === "string") ids.push(id);
  }
  return ids;
};

export const transcribeFiles = async (
  client: DagloApiClient,
  args: TranscribeArgs
): Promise<TranscribeResult> => {
  // Validate files up front.
  for (const filePath of args.files) {
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }
    if (stat.size === 0) {
      throw new Error(`File is empty: ${filePath}`);
    }
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      logger.warn(
        `File exceeds 500MB and may be rejected by the server: ${filePath} (${stat.size} bytes)`
      );
    }
  }

  const workspaceId = await resolveWorkspaceId(client);
  const headers: WorkspaceHeaders = {
    "daglo-workspace-id": workspaceId,
    platform: "web",
  };

  // Resolve options: account defaults, overridden by explicit flags.
  const saved = await fetchUserTranscriptionOption(client, headers);
  const options: Required<UserTranscriptionOption> = {
    language: args.language ?? saved.language ?? "ko-KR",
    topic: args.topic ?? saved.topic ?? "GENERAL",
    useSpeakerDiarization:
      args.useSpeakerDiarization ?? saved.useSpeakerDiarization ?? true,
    useDictionary: args.useDictionary ?? saved.useDictionary ?? false,
  };

  const files: TranscribeFileResult[] = [];
  for (const filePath of args.files) {
    const name = basename(filePath);
    logger.info(`Uploading ${name}...`);

    const slot = await createFileSlot(client, headers, name);
    await uploadToGcs(slot.signedUrl, filePath);
    const finalized = await finalizeUpload(client, headers, slot.fileMeta.id);

    files.push({
      name,
      fileMetaId: slot.fileMeta.id,
      fileId: slot.fileId,
      duration: finalized.duration,
      size: finalized.size,
    });
    logger.info(`Uploaded ${name} (fileMetaId=${slot.fileMeta.id})`);
  }

  const fileMetaIds = files.map((f) => f.fileMetaId);
  await requestTranscription(client, headers, fileMetaIds, options);

  const boardId = await findBoardId(
    client,
    headers,
    fileMetaIds,
    Math.max(10, fileMetaIds.length)
  );

  return { boardId, fileMetaIds, files, options };
};
