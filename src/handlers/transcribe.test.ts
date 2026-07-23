import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: vi.fn(() => ({ isFile: () => true, size: 1024 })),
    readFileSync: vi.fn(() => Buffer.from("audio-bytes")),
  };
});

import { DagloApiClient } from "../api/client.js";
import { transcribeFiles } from "./transcribe.js";

global.fetch = vi.fn() as any;

const SIGNED_URL = "https://storage.googleapis.com/bucket/obj.mp3?X-Goog-Signature=abc";
const SESSION_URI = `${SIGNED_URL}&upload_id=xyz`;

/** Route mocked fetch responses by URL + method to emulate the daglo upload flow. */
const routeFetch = (overrides: Record<string, any> = {}) => {
  (global.fetch as any).mockImplementation(async (url: string, init: any = {}) => {
    const method = (init.method ?? "GET").toUpperCase();

    if (url.endsWith("/workspaces")) {
      return { ok: true, json: async () => [{ id: "ws-uuid", isDefault: true }] };
    }
    if (url.endsWith("/user-option/transcription")) {
      return {
        ok: true,
        json: async () => ({
          language: "ko-KR",
          topic: "MEDICINE",
          useSpeakerDiarization: true,
          useDictionary: false,
        }),
      };
    }
    if (url.endsWith("/files") && method === "POST") {
      return {
        ok: true,
        json: async () => ({
          fileId: "file-1",
          fileMeta: { id: "fm-1" },
          signedUrl: SIGNED_URL,
        }),
      };
    }
    if (url === SIGNED_URL && method === "POST") {
      return {
        status: 201,
        headers: { get: (k: string) => (k === "location" ? SESSION_URI : null) },
      };
    }
    if (url === SESSION_URI && method === "PUT") {
      return { ok: true };
    }
    if (url.endsWith("/file/metadata") && method === "POST") {
      return { ok: true, json: async () => ({ id: "file-1", duration: 15.05, size: 1024 }) };
    }
    if (url.endsWith("/transcript-request") && method === "POST") {
      return { ok: true, json: async () => ({ fileMetaIds: ["fm-1"] }) };
    }
    if (url.includes("/v2/boards")) {
      return {
        ok: true,
        json: async () => ({ items: [{ id: "board-1", fileMeta: [{ id: "fm-1" }] }] }),
      };
    }
    if (overrides[url]) return overrides[url];
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
};

describe("transcribeFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uploads a file and requests transcription, returning ids", async () => {
    routeFetch();
    const client = new DagloApiClient();

    const result = await transcribeFiles(client, { files: ["a.mp3"] });

    expect(result.fileMetaIds).toEqual(["fm-1"]);
    expect(result.boardId).toBe("board-1");
    expect(result.files[0]).toMatchObject({
      name: "a.mp3",
      fileMetaId: "fm-1",
      fileId: "file-1",
      duration: 15.05,
    });
  });

  it("sends workspace + platform headers on /files", async () => {
    routeFetch();
    const client = new DagloApiClient();
    await transcribeFiles(client, { files: ["a.mp3"] });

    const filesCall = (global.fetch as any).mock.calls.find(
      (c: any[]) => c[0].endsWith("/files")
    );
    expect(filesCall[1].headers["daglo-workspace-id"]).toBe("ws-uuid");
    expect(filesCall[1].headers.platform).toBe("web");
  });

  it("starts a GCS resumable session with x-goog-resumable header (no auth)", async () => {
    routeFetch();
    const client = new DagloApiClient();
    await transcribeFiles(client, { files: ["a.mp3"] });

    const startCall = (global.fetch as any).mock.calls.find(
      (c: any[]) => c[0] === SIGNED_URL && (c[1]?.method ?? "").toUpperCase() === "POST"
    );
    expect(startCall[1].headers["x-goog-resumable"]).toBe("start");
    expect(startCall[1].headers.Authorization).toBeUndefined();
  });

  it("explicit flags override account defaults in transcript-request", async () => {
    routeFetch();
    const client = new DagloApiClient();
    await transcribeFiles(client, {
      files: ["a.mp3"],
      language: "en-US",
      useSpeakerDiarization: false,
      useDictionary: true,
    });

    const trCall = (global.fetch as any).mock.calls.find((c: any[]) =>
      c[0].endsWith("/transcript-request")
    );
    const body = JSON.parse(trCall[1].body);
    expect(body).toMatchObject({
      language: "en-US",
      topic: "MEDICINE", // untouched -> from account default
      useSpeakerDiarization: false,
      useDictionary: true,
      fileMetaIds: ["fm-1"],
    });
  });

  it("handles multiple files in one transcript-request", async () => {
    routeFetch();
    const client = new DagloApiClient();
    const result = await transcribeFiles(client, { files: ["a.mp3", "b.mp3"] });

    expect(result.fileMetaIds).toEqual(["fm-1", "fm-1"]);
    const trCall = (global.fetch as any).mock.calls.find((c: any[]) =>
      c[0].endsWith("/transcript-request")
    );
    expect(JSON.parse(trCall[1].body).fileMetaIds).toHaveLength(2);
  });

  it("throws a clear error when the file does not exist", async () => {
    const fs = await import("node:fs");
    (fs.statSync as any).mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    const client = new DagloApiClient();

    await expect(transcribeFiles(client, { files: ["missing.mp3"] })).rejects.toThrow(
      "File not found: missing.mp3"
    );
  });
});
