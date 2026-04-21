import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DagloApiClient } from "../api/client.js";
import { DagloBoardDetail } from "../types.js";
import { normalizeBoardList, pickLatestBoard } from "../utils/board.js";
import {
  buildScriptPages,
  decodeScriptItem,
  decodeZlibBase64Content,
  normalizeScriptContent,
} from "../utils/content.js";
import {
  buildDefaultOutputPath,
  buildPlainTextFromScriptPayload,
} from "../utils/file.js";
import {
  buildPlainTextFromTokens,
  collectKaraokeTokens,
  extractKaraokeTokens,
  KaraokeToken,
  splitTokensByPunctuation,
} from "../utils/karaoke.js";
import { buildUrl, parseResponseBody } from "../utils/http.js";
import {
  GetBoardsArgs,
  GetBoardInfoArgs,
  GetBoardDetailArgs,
  GetBoardScriptArgs,
  UpdateBoardNameArgs,
  GetLatestBoardContentArgs,
  ExportBoardContentArgs,
} from "../schemas/boards.js";

export const listBoards = async (
  client: DagloApiClient,
  args: GetBoardsArgs
): Promise<unknown> => {
  const params = new URLSearchParams();
  if (args.page) params.append("page", args.page.toString());
  if (args.limit) params.append("limit", args.limit.toString());

  const sort =
    args.sort ??
    (args.orderedBy && args.timeOrder
      ? `${args.orderedBy}.${args.timeOrder}`
      : "createTime.desc");
  params.append("sort", sort);

  if (args.status) params.append("filter.status", args.status);
  if (args.isStarred !== undefined) {
    params.append("filter.isStarred", String(args.isStarred));
  }
  if (args.search) params.append("filter.name", args.search);
  if (args.uploadTypes?.length) {
    args.uploadTypes.forEach((type) => params.append("filter.uploadTypes", type));
  }
  if (args.folderIds?.length) {
    args.folderIds.forEach((id) => params.append("filter.folderIds", id));
  }
  if (args.startDate) params.append("filter.startDate", args.startDate);
  if (args.endDate) params.append("filter.endDate", args.endDate);
  if (args.withDeleted !== undefined) {
    params.append("filter.withDeleted", String(args.withDeleted));
  }
  if (args.folderId) params.append("folderId", args.folderId);
  if (args.keyword) params.append("keyword", args.keyword);
  if (args.checkedFilter) params.append("checkedFilter", args.checkedFilter);

  const response = await client.request(`/v2/boards?${params.toString()}`);

  if (!response.ok) {
    throw new Error(`Failed to fetch boards: ${response.statusText}`);
  }

  return (await response.json()) as unknown;
};

export const getBoardInfo = async (
  client: DagloApiClient,
  args: GetBoardInfoArgs
): Promise<unknown> => {
  if (!args.boardId && !args.sharedBoardId) {
    throw new Error("Provide boardId or sharedBoardId.");
  }

  const path = args.sharedBoardId
    ? `/shared-board/${args.sharedBoardId}`
    : `/boards/${args.boardId}`;
  const init = args.sharedBoardId
    ? { headers: { "daglo-platform": "web" } }
    : {};

  const response = await client.request(path, init);
  if (!response.ok) {
    throw new Error(`Failed to fetch board info: ${response.statusText}`);
  }

  return await parseResponseBody(response);
};

export const getBoardDetail = async (
  client: DagloApiClient,
  args: GetBoardDetailArgs
): Promise<unknown> => {
  const shouldIncludeContent = args.includeContent !== false;
  const shouldIncludeSummary = args.includeSummary !== false;
  const shouldIncludeKeywords = args.includeKeywords !== false;
  const shouldIncludeSegments = args.includeSegments !== false;
  const shouldIncludeAiSummary = args.includeAiSummary !== false;
  const shouldDecodeContent = args.decodeContent !== false;
  const shouldIncludeScript = args.includeScript === true;
  const shouldIncludeScriptPages = args.includeScriptPages !== false;
  const scriptLimit = args.scriptLimit ?? 60;
  const scriptPage = args.scriptPage ?? 0;
  const outputFormat = args.outputFormat ?? "json";

  let scriptPayload:
    | {
        meta?: { totalPages?: number } | null;
        script?: Record<string, unknown> | null;
        pages?: Array<Record<string, unknown>>;
      }
    | null = null;

  if (args.fileMetaId) {
    const scriptQuery = new URLSearchParams();
    scriptQuery.append("limit", scriptLimit.toString());
    scriptQuery.append("page", scriptPage.toString());
    const scriptResponse = await client.request(
      `/file-meta/${args.fileMetaId}/script?${scriptQuery.toString()}`
    );

    if (scriptResponse.ok) {
      const scriptData = (await scriptResponse.json()) as {
        item?: string;
        meta?: { totalPages?: number };
      };
      const script = decodeScriptItem(scriptData?.item);
      const totalPages = scriptData?.meta?.totalPages ?? 1;
      const pages =
        script && shouldIncludeScriptPages
          ? buildScriptPages(script, totalPages, scriptLimit)
          : [];

      scriptPayload = {
        meta: scriptData?.meta ?? null,
        script: shouldIncludeScript ? script : null,
        pages: shouldIncludeScriptPages ? pages : undefined,
      };
    }
  }

  const response = await client.request(`/boards/${args.boardId}`);

  if (!response.ok) {
    throw new Error(`Failed to fetch board detail: ${response.statusText}`);
  }

  const fullData = (await response.json()) as DagloBoardDetail;

  const filteredData: Partial<DagloBoardDetail> & {
    decodedContent?: string | null;
    contentDecoded?: boolean;
  } = {
    id: fullData.id,
    name: fullData.name,
    status: fullData.status,
    type: fullData.type,
    createdAt: fullData.createdAt,
    updatedAt: fullData.updatedAt,
    isStarred: fullData.isStarred,
    folderId: fullData.folderId,
  };

  if (shouldIncludeContent && fullData.content) {
    filteredData.content = fullData.content;
    if (shouldDecodeContent) {
      const decoded = decodeZlibBase64Content(fullData.content);
      filteredData.decodedContent = decoded;
      filteredData.contentDecoded = decoded !== fullData.content;
    }
  }

  if (shouldIncludeSummary) {
    let summaryData: unknown = null;
    if (args.fileMetaId) {
      const summaryResponse = await client.request(
        `/file-meta/${args.fileMetaId}/summary`
      );
      if (summaryResponse.ok) {
        summaryData = await parseResponseBody(summaryResponse);
      }
    }
    (filteredData as Record<string, unknown>).summary =
      summaryData ?? fullData.summary;
  }

  if (shouldIncludeKeywords) {
    let keywordsData: unknown = null;
    if (args.fileMetaId) {
      const keywordResponse = await client.request(
        `/file-meta/${args.fileMetaId}/keyword`
      );
      if (keywordResponse.ok) {
        keywordsData = await parseResponseBody(keywordResponse);
      }
    }
    (filteredData as Record<string, unknown>).keywords =
      keywordsData ?? fullData.keywords;
  }

  if (shouldIncludeAiSummary) {
    let aiSummaryData: unknown = null;
    if (args.fileMetaId) {
      const longSummaryResponse = await client.request(
        `/file-meta/${args.fileMetaId}/long-summary`
      );
      if (longSummaryResponse.ok) {
        aiSummaryData = await parseResponseBody(longSummaryResponse);
      }
    }
    (filteredData as Record<string, unknown>).aiSummary =
      aiSummaryData ?? fullData.aiSummary;
  }

  if (shouldIncludeSegments) {
    let segmentData: unknown = null;
    if (args.fileMetaId) {
      const segmentResponse = await client.request(
        `/file-meta/${args.fileMetaId}/segment-summary`
      );
      if (segmentResponse.ok) {
        segmentData = await parseResponseBody(segmentResponse);
      }
    }
    (filteredData as Record<string, unknown>).segments =
      segmentData ?? fullData.segments;
  }

  if (scriptPayload && (shouldIncludeScript || shouldIncludeScriptPages)) {
    (filteredData as Record<string, unknown>).script =
      scriptPayload.script ?? undefined;
    (filteredData as Record<string, unknown>).scriptPages =
      scriptPayload.pages ?? undefined;
    (filteredData as Record<string, unknown>).scriptMeta =
      scriptPayload.meta ?? null;
  }

  if (outputFormat === "text") {
    const normalizedContent = fullData.content
      ? normalizeScriptContent(fullData.content)
      : "";
    const plainText = buildPlainTextFromScriptPayload(
      scriptPayload?.script,
      normalizedContent || filteredData.decodedContent || fullData.content
    );
    const outputPath =
      args.outputPath ??
      buildDefaultOutputPath(fullData.name ?? args.boardId, "txt");
    const contentSource = scriptPayload?.script ? "script" : "content";

    writeFileSync(outputPath, plainText, "utf8");
    return {
      outputPath,
      contentLength: plainText.length,
      contentSource,
    };
  }

  const jsonText = JSON.stringify(filteredData, null, 2);
  if (outputFormat === "json") {
    const outputPath =
      args.outputPath ??
      buildDefaultOutputPath(fullData.name ?? args.boardId, "json");
    writeFileSync(outputPath, jsonText, "utf8");
    return {
      outputPath,
      contentLength: jsonText.length,
    };
  }

  return filteredData;
};

export const getBoardScript = async (
  client: DagloApiClient,
  args: GetBoardScriptArgs
): Promise<unknown> => {
  const limit = args.limit ?? 60;
  const page = args.page ?? 0;
  const buildPages = args.buildPages !== false;

  let path = "";
  if (args.sharedBoardId) {
    path = `/shared-board/${args.sharedBoardId}/script`;
  } else if (args.fileMetaId && args.historyId) {
    path = `/file-meta/${args.fileMetaId}/script-history/${args.historyId}`;
  } else if (args.fileMetaId && args.isOriginal) {
    path = `/file-meta/${args.fileMetaId}/original/script`;
  } else if (args.fileMetaId) {
    path = `/file-meta/${args.fileMetaId}/script`;
  } else {
    throw new Error("Provide fileMetaId or sharedBoardId.");
  }

  const url = buildUrl(client.baseUrl, path, {
    limit,
    page,
  });

  const response = await client.request(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch script: ${response.statusText}`);
  }

  const data = (await response.json()) as {
    item?: string;
    meta?: { totalPages?: number };
  };
  const script = decodeScriptItem(data?.item);
  const totalPages = data?.meta?.totalPages ?? 1;
  const pages = script && buildPages ? buildScriptPages(script, totalPages, limit) : [];

  return {
    meta: data?.meta ?? null,
    script,
    pages: buildPages ? pages : undefined,
  };
};

export const updateBoardName = async (
  client: DagloApiClient,
  args: UpdateBoardNameArgs
): Promise<unknown> => {
  const requestBody = { name: args.name };

  const response = await client.request(`/boards/${args.boardId}`, {
    method: "PATCH",
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    throw new Error(`Failed to update board name: ${response.statusText}`);
  }

  return await parseResponseBody(response);
};

export const getLatestBoardContent = async (
  client: DagloApiClient,
  args: GetLatestBoardContentArgs
): Promise<unknown> => {
  const params = new URLSearchParams();
  const limit = args.limit ?? 50;
  params.append("page", "1");
  params.append("limit", limit.toString());
  params.append("sort", "createTime.desc");

  const listResponse = await client.request(`/v2/boards?${params.toString()}`);

  if (!listResponse.ok) {
    throw new Error(`Failed to fetch boards: ${listResponse.statusText}`);
  }

  const listData = (await listResponse.json()) as unknown;
  const boards = normalizeBoardList(listData);
  const latestBoard = pickLatestBoard(boards);

  if (!latestBoard) {
    throw new Error("No boards found to determine latest board.");
  }

  const detailParams = new URLSearchParams();
  detailParams.append("includeContent", "true");

  let rawContent: string | undefined;
  let contentSource = "board";
  const latestBoardId = latestBoard.id as string | undefined;
  const latestBoardName = latestBoard.name as string | undefined;
  const latestBoardCreatedAt =
    (latestBoard.createdAt as string | undefined) ??
    (latestBoard.createTime as string | undefined) ??
    null;
  const latestBoardUpdatedAt =
    (latestBoard.updatedAt as string | undefined) ??
    (latestBoard.updateTime as string | undefined) ??
    null;

  const latestBoardFileMetaId = latestBoard.fileMetaId as string | undefined;
  if (latestBoardFileMetaId) {
    const scriptResponse = await client.request(
      `/file-meta/${latestBoardFileMetaId}/script?${detailParams.toString()}`
    );

    if (scriptResponse.ok) {
      const scriptData = (await scriptResponse.json()) as
        | { content?: string; script?: string; text?: string }
        | string;
      if (typeof scriptData === "string") {
        rawContent = scriptData;
      } else {
        rawContent =
          scriptData.content ??
          scriptData.script ??
          scriptData.text ??
          (scriptData as { item?: string }).item;
      }
      contentSource = "file-meta";
    }
  }

  if (!rawContent) {
    if (!latestBoardId) {
      throw new Error("Latest board is missing id.");
    }

    let detailResponse = await client.request(
      `/v2/boards/${latestBoardId}?${detailParams.toString()}`
    );

    if (!detailResponse.ok) {
      detailResponse = await client.request(
        `/boards/${latestBoardId}?${detailParams.toString()}`
      );
    }

    if (!detailResponse.ok) {
      throw new Error(`Failed to fetch board detail: ${detailResponse.statusText}`);
    }

    const detailData = (await detailResponse.json()) as DagloBoardDetail;
    rawContent = detailData.content;
  }

  const isContentDecoded = args.decodeContent !== false;
  const content = rawContent
    ? isContentDecoded
      ? decodeZlibBase64Content(rawContent)
      : rawContent
    : null;

  return {
    id: latestBoardId,
    name: latestBoardName,
    createdAt: latestBoardCreatedAt,
    updatedAt: latestBoardUpdatedAt,
    content,
    isContentDecoded,
    contentSource,
  };
};

const fetchAllScriptPages = async (
  client: DagloApiClient,
  fileMetaId: string,
  limit = 60
): Promise<Record<string, unknown>[] | null> => {
  const scripts: Record<string, unknown>[] = [];
  const firstUrl = buildUrl(client.baseUrl, `/file-meta/${fileMetaId}/script`, {
    limit,
    page: 0,
  });
  const firstResponse = await client.request(firstUrl);

  if (!firstResponse.ok) {
    return null;
  }

  const firstPayload = (await parseResponseBody(firstResponse)) as {
    item?: string;
    meta?: { totalPages?: number };
  };
  const firstScript = decodeScriptItem(firstPayload?.item);
  if (firstScript) {
    scripts.push(firstScript);
  }

  const totalPages = firstPayload?.meta?.totalPages ?? 1;
  for (let page = 1; page < totalPages; page += 1) {
    const pageUrl = buildUrl(client.baseUrl, `/file-meta/${fileMetaId}/script`, {
      limit,
      page,
    });
    const pageResponse = await client.request(pageUrl);

    if (!pageResponse.ok) {
      throw new Error(`Failed to fetch script page ${page}: ${pageResponse.statusText}`);
    }

    const pagePayload = (await parseResponseBody(pageResponse)) as { item?: string };
    const pageScript = decodeScriptItem(pagePayload?.item);
    if (pageScript) {
      scripts.push(pageScript);
    }
  }

  return scripts;
};

const extractTokensFromScripts = (scripts: Record<string, unknown>[]) => {
  const tokens: KaraokeToken[] = [];

  scripts.forEach((script) => {
    const editorState = script.editorState as Record<string, unknown> | undefined;

    if (editorState?.root) {
      collectKaraokeTokens(editorState.root, tokens);
      return;
    }

    if (editorState) {
      collectKaraokeTokens(editorState, tokens);
      return;
    }

    collectKaraokeTokens(script, tokens);
  });

  return tokens;
};

export const exportBoardContent = async (
  client: DagloApiClient,
  args: ExportBoardContentArgs
): Promise<unknown> => {
  let targetBoardId = args.boardId;
  let targetFileMetaId = args.fileMetaId;

  if (!targetBoardId) {
    const params = new URLSearchParams();
    const limit = args.limit ?? 50;
    params.append("page", "1");
    params.append("limit", limit.toString());
    params.append("sort", "createTime.desc");

    const listResponse = await client.request(`/v2/boards?${params.toString()}`);

    if (!listResponse.ok) {
      throw new Error(`Failed to fetch boards: ${listResponse.statusText}`);
    }

    const listData = (await listResponse.json()) as unknown;
    const boards = normalizeBoardList(listData);
    const latestBoard = pickLatestBoard(boards);

    if (!latestBoard) {
      throw new Error("No boards found to determine latest board.");
    }

    targetBoardId = latestBoard.id as string | undefined;
    targetFileMetaId =
      targetFileMetaId ?? (latestBoard.fileMetaId as string | undefined);
  }

  if (!targetBoardId && !targetFileMetaId) {
    throw new Error("Provide boardId or fileMetaId.");
  }

  const detailParams = new URLSearchParams();
  detailParams.append("includeContent", "true");

  let rawContent: string | undefined;
  let scriptTokens: KaraokeToken[] = [];
  let contentSource = "board";

  if (targetFileMetaId) {
    const scripts = await fetchAllScriptPages(client, targetFileMetaId);

    if (scripts) {
      scriptTokens = extractTokensFromScripts(scripts);
      contentSource = "file-meta";
    }
  }

  if (!rawContent) {
    if (!targetBoardId) {
      throw new Error("Board detail fetch requires boardId.");
    }

    let detailResponse = await client.request(
      `/v2/boards/${targetBoardId}?${detailParams.toString()}`
    );

    if (!detailResponse.ok) {
      detailResponse = await client.request(
        `/boards/${targetBoardId}?${detailParams.toString()}`
      );
    }

    if (!detailResponse.ok) {
      throw new Error(`Failed to fetch board detail: ${detailResponse.statusText}`);
    }

    const detailData = (await detailResponse.json()) as DagloBoardDetail;
    rawContent = detailData.content;
  }

  const normalizedContent = rawContent ? normalizeScriptContent(rawContent) : "";
  const tokens =
    scriptTokens.length > 0 ? scriptTokens : extractKaraokeTokens(normalizedContent);

  if (args.format === "punctuation-json") {
    const segments = splitTokensByPunctuation(tokens);
    const outputPath =
      args.outputPath ??
      resolve(process.cwd(), ".code/latest-board-segments.json");
    writeFileSync(outputPath, JSON.stringify(segments, null, 2), "utf8");

    return {
      outputPath,
      segmentCount: segments.length,
      contentSource,
    };
  }

  let plainText = buildPlainTextFromTokens(tokens);
  if (!plainText && normalizedContent) {
    plainText = normalizedContent;
  }
  const outputPath =
    args.outputPath ?? resolve(process.cwd(), ".code/latest-board-content.txt");
  writeFileSync(outputPath, plainText, "utf8");

  return {
    outputPath,
    contentLength: plainText.length,
    contentSource,
  };
};
