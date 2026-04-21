import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { deflateSync } from "node:zlib";
import { DagloApiClient } from "../api/client.js";
import {
  listBoards,
  getBoardInfo,
  getBoardDetail,
  getBoardScript,
  updateBoardName,
  getLatestBoardContent,
  exportBoardContent,
} from "./boards.js";

global.fetch = vi.fn() as any;

const encodeScriptItem = (value: unknown) =>
  deflateSync(Buffer.from(JSON.stringify(value), "utf8")).toString("base64");

describe("listBoards", () => {
  beforeEach(() => vi.clearAllMocks());

  it("hits /v2/boards and returns parsed payload", async () => {
    const payload = { items: [{ id: "b1" }] };
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => payload,
    });

    const client = new DagloApiClient();
    const result = await listBoards(client, { page: 1, limit: 10 });
    expect(result).toEqual(payload);
    expect((global.fetch as any).mock.calls[0][0]).toContain("/v2/boards");
  });

  it("applies filter params when provided", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });

    const client = new DagloApiClient();
    await listBoards(client, { status: "COMPLETE", isStarred: true });

    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain("filter.status=COMPLETE");
    expect(url).toContain("filter.isStarred=true");
  });

  it("throws on non-ok response", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      statusText: "Unauthorized",
    });

    const client = new DagloApiClient();
    await expect(listBoards(client, {})).rejects.toThrow(
      "Failed to fetch boards: Unauthorized"
    );
  });
});

describe("getBoardInfo", () => {
  beforeEach(() => vi.clearAllMocks());

  it("hits /boards/:boardId for private board and returns data", async () => {
    const payload = { id: "b1", name: "My Board" };
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    });

    const client = new DagloApiClient();
    const result = await getBoardInfo(client, { boardId: "b1" });
    expect(result).toEqual(payload);
    expect((global.fetch as any).mock.calls[0][0]).toContain("/boards/b1");
  });

  it("hits /shared-board/:id for shared board", async () => {
    const payload = { id: "sb1" };
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    });

    const client = new DagloApiClient();
    await getBoardInfo(client, { sharedBoardId: "sb1" });

    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain("/shared-board/sb1");
  });

  it("throws when neither boardId nor sharedBoardId provided", async () => {
    const client = new DagloApiClient();
    await expect(getBoardInfo(client, {})).rejects.toThrow(
      "Provide boardId or sharedBoardId."
    );
  });
});

describe("getBoardDetail", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fetches board detail and returns json summary object", async () => {
    const boardPayload = {
      id: "b1",
      name: "Board One",
      status: "COMPLETE",
      type: "audio",
      createdAt: "2024-01-01",
      updatedAt: "2024-01-02",
      isStarred: false,
      folderId: null,
      content: null,
      summary: "summary text",
      keywords: [],
      aiSummary: null,
      segments: [],
    };

    // getBoardDetail with outputFormat: "json" will write a file,
    // so we need to provide an outputPath to a temp file.
    const tmpFile = path.join(os.tmpdir(), `board-detail-test-${Date.now()}.json`);

    // Calls: boards/:boardId, file-meta/summary, file-meta/keyword, file-meta/long-summary, file-meta/segment-summary
    // Without fileMetaId, only boards/:boardId is called.
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => boardPayload,
      headers: { get: () => "application/json" },
    });

    const client = new DagloApiClient();
    const result = await getBoardDetail(client, {
      boardId: "b1",
      outputFormat: "json",
      outputPath: tmpFile,
    });

    expect(result).toMatchObject({ outputPath: tmpFile });
    expect((result as any).contentLength).toBeGreaterThan(0);
    expect((global.fetch as any).mock.calls[0][0]).toContain("/boards/b1");

    fs.unlinkSync(tmpFile);
  });

  it("returns text summary object when outputFormat is text", async () => {
    const boardPayload = {
      id: "b2",
      name: "Board Two",
      status: "COMPLETE",
      content: null,
    };
    const tmpFile = path.join(os.tmpdir(), `board-detail-text-test-${Date.now()}.txt`);

    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => boardPayload,
      headers: { get: () => "application/json" },
    });

    const client = new DagloApiClient();
    const result = await getBoardDetail(client, {
      boardId: "b2",
      outputFormat: "text",
      outputPath: tmpFile,
    });

    expect(result).toMatchObject({ outputPath: tmpFile, contentSource: "content" });
    fs.unlinkSync(tmpFile);
  });
});

describe("getBoardScript", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fetches /file-meta/:id/script and returns decoded script payload", async () => {
    const payload = { item: null, meta: { totalPages: 1 } };
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => payload,
    });

    const client = new DagloApiClient();
    const result = await getBoardScript(client, { fileMetaId: "fm1" });
    expect(result).toMatchObject({ meta: payload.meta, script: null });
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain("/file-meta/fm1/script");
  });

  it("fetches /shared-board/:id/script for sharedBoardId", async () => {
    const payload = { item: null, meta: { totalPages: 1 } };
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => payload,
    });

    const client = new DagloApiClient();
    await getBoardScript(client, { sharedBoardId: "sb1" });

    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain("/shared-board/sb1/script");
  });

  it("throws when neither fileMetaId nor sharedBoardId provided", async () => {
    const client = new DagloApiClient();
    await expect(getBoardScript(client, {})).rejects.toThrow(
      "Provide fileMetaId or sharedBoardId."
    );
  });
});

describe("updateBoardName", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends PATCH to /boards/:boardId and returns response data", async () => {
    const payload = { id: "b1", name: "New Name" };
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    });

    const client = new DagloApiClient();
    const result = await updateBoardName(client, { boardId: "b1", name: "New Name" });
    expect(result).toEqual(payload);

    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(url).toContain("/boards/b1");
    expect(init.method).toBe("PATCH");
  });

  it("throws on non-ok response", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      statusText: "Not Found",
    });

    const client = new DagloApiClient();
    await expect(
      updateBoardName(client, { boardId: "b1", name: "Name" })
    ).rejects.toThrow("Failed to update board name: Not Found");
  });
});

describe("getLatestBoardContent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fetches board list then board detail and returns content payload", async () => {
    const listPayload = {
      items: [
        {
          id: "b1",
          name: "Latest Board",
          createdAt: "2024-01-01",
          updatedAt: "2024-01-02",
        },
      ],
    };
    const detailPayload = {
      id: "b1",
      content: "some content",
    };

    (global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => listPayload,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => detailPayload,
      });

    const client = new DagloApiClient();
    const result = await getLatestBoardContent(client, {});

    expect(result).toMatchObject({ id: "b1", name: "Latest Board" });
    const firstUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(firstUrl).toContain("/v2/boards");
  });

  it("throws when no boards found", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });

    const client = new DagloApiClient();
    await expect(getLatestBoardContent(client, {})).rejects.toThrow(
      "No boards found to determine latest board."
    );
  });
});

describe("exportBoardContent", () => {
  let tmpFile: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpFile = path.join(os.tmpdir(), `export-board-test-${Date.now()}.txt`);
  });

  afterEach(() => {
    if (fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  it("exports text format to specified output path", async () => {
    const listPayload = {
      items: [
        {
          id: "b1",
          name: "Board",
          createdAt: "2024-01-01",
        },
      ],
    };
    const detailPayload = { id: "b1", content: "" };

    (global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => listPayload,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => detailPayload,
      });

    const client = new DagloApiClient();
    const result = await exportBoardContent(client, {
      format: "text",
      outputPath: tmpFile,
    });

    expect(result).toMatchObject({ outputPath: tmpFile, contentSource: "board" });
    expect(fs.existsSync(tmpFile)).toBe(true);
  });

  it("exports full text across all script pages when fileMetaId is present", async () => {
    const listPayload = {
      items: [
        {
          id: "b1",
          name: "Board",
          createdAt: "2024-01-01",
          fileMetaId: "fm1",
        },
      ],
    };
    const firstPageScript = {
      editorState: {
        root: {
          children: [
            {
              children: [
                { type: "karaoke", text: "Hello ", s: 0, e: 0.5 },
                { type: "karaoke", text: "world.", s: 0.5, e: 1 },
              ],
            },
          ],
        },
      },
    };
    const secondPageScript = {
      editorState: {
        root: {
          children: [
            {
              children: [
                { type: "karaoke", text: " Goodbye", s: 1, e: 1.5 },
                { type: "karaoke", text: ".", s: 1.5, e: 2 },
              ],
            },
          ],
        },
      },
    };

    (global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => listPayload,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          item: encodeScriptItem(firstPageScript),
          meta: { totalPages: 2 },
        }),
        text: async () =>
          JSON.stringify({
            item: encodeScriptItem(firstPageScript),
            meta: { totalPages: 2 },
          }),
        headers: { get: () => "application/json" },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ item: encodeScriptItem(secondPageScript) }),
        text: async () => JSON.stringify({ item: encodeScriptItem(secondPageScript) }),
        headers: { get: () => "application/json" },
      });

    const client = new DagloApiClient();
    const result = await exportBoardContent(client, {
      format: "text",
      outputPath: tmpFile,
    });

    expect(result).toMatchObject({ outputPath: tmpFile, contentSource: "file-meta" });
    expect(fs.readFileSync(tmpFile, "utf8")).toBe("Hello world. Goodbye.");
    expect((global.fetch as any).mock.calls[1][0]).toContain("/file-meta/fm1/script");
    expect((global.fetch as any).mock.calls[2][0]).toContain("page=1");
  });

  it("exports punctuation-json format with boardId", async () => {
    const detailPayload = { id: "b2", content: "" };
    const tmpJsonFile = path.join(os.tmpdir(), `export-board-json-test-${Date.now()}.json`);

    (global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => detailPayload,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => detailPayload,
      });

    const client = new DagloApiClient();
    const result = await exportBoardContent(client, {
      format: "punctuation-json",
      boardId: "b2",
      outputPath: tmpJsonFile,
    });

    expect(result).toMatchObject({ outputPath: tmpJsonFile, contentSource: "board" });
    expect((result as any).segmentCount).toBeGreaterThanOrEqual(0);

    if (fs.existsSync(tmpJsonFile)) {
      fs.unlinkSync(tmpJsonFile);
    }
  });
});
