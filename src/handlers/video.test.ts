import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DagloApiClient } from "../api/client.js";
import {
  buildCues,
  createYoutubeHighlightClip,
  createYoutubeFullSubtitledVideo,
  resolveBoardDerivedVideoSource,
} from "./video.js";

const { execSyncMock, existsSyncMock, mkdirSyncMock, writeFileSyncMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: execSyncMock,
}));

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
}));

global.fetch = vi.fn() as any;

const jsonResponse = (payload: unknown) => ({
  ok: true,
  text: async () => JSON.stringify(payload),
});

const scriptResponse = (payload: unknown, totalPages = 1) =>
  jsonResponse({
    item: JSON.stringify(payload),
    meta: { totalPages },
  });

describe("createYoutubeHighlightClip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(false);
  });

  it("is a function", () => {
    expect(typeof createYoutubeHighlightClip).toBe("function");
  });

  it("throws when neither boardId nor fileMetaId is provided", async () => {
    const client = new DagloApiClient();
    await expect(
      createYoutubeHighlightClip(client, {
        youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      })
    ).rejects.toThrow("Provide boardId or fileMetaId to fetch transcript.");
  });
});

describe("resolveBoardDerivedVideoSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(false);
  });

  it("resolves fileMeta fallback and a single nested youtube url", async () => {
    (global.fetch as any).mockResolvedValue(
      jsonResponse({
        fileMeta: [{ id: "fm-1" }],
        shareUrl: { url: "https://daglo.ai/share/abc123" },
        nested: {
          items: [
            {
              source: {
                url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
              },
            },
          ],
        },
      })
    );

    const client = new DagloApiClient();
    await expect(resolveBoardDerivedVideoSource(client, "board-1")).resolves.toEqual({
      fileMetaId: "fm-1",
      youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
  });

  it("throws when no youtube url is found in board detail", async () => {
    (global.fetch as any).mockResolvedValue(
      jsonResponse({
        fileMetaId: "fm-2",
        shareUrl: { url: "https://daglo.ai/share/only-share-url" },
        content: { text: "no video source here" },
      })
    );

    const client = new DagloApiClient();
    await expect(resolveBoardDerivedVideoSource(client, "board-2")).rejects.toThrow(
      "No YouTube URL found for board board-2."
    );
  });

  it("throws with candidates when multiple youtube urls are found", async () => {
    (global.fetch as any).mockResolvedValue(
      jsonResponse({
        fileMetaId: "fm-3",
        clips: [
          { url: "https://youtu.be/abc123xyz99" },
          { url: "https://www.youtube.com/live/live98765432" },
        ],
      })
    );

    const client = new DagloApiClient();
    await expect(resolveBoardDerivedVideoSource(client, "board-3")).rejects.toThrow(
      "Multiple YouTube URLs found for board board-3: https://youtu.be/abc123xyz99, https://www.youtube.com/live/live98765432"
    );
  });

  it("skips youtube url search when positional youtubeUrl is already provided", async () => {
    (global.fetch as any)
      .mockResolvedValueOnce(
        jsonResponse({
          fileMetaId: "fm-4",
          nested: {
            primary: "https://youtu.be/abc123xyz99",
            secondary: "https://www.youtube.com/shorts/short1234567",
          },
        })
      )
      .mockResolvedValueOnce({ ok: false, statusText: "Bad Request" });

    const client = new DagloApiClient();
    await expect(
      createYoutubeFullSubtitledVideo(client, {
        boardId: "board-4",
        youtubeUrl: "https://youtu.be/already-provided",
      } as any)
    ).rejects.toThrow("Failed to fetch script: Bad Request");

    expect((global.fetch as any)).toHaveBeenCalledTimes(2);
    expect((global.fetch as any).mock.calls[1][0]).toContain("/file-meta/fm-4/script");
  });
});

describe("createYoutubeFullSubtitledVideo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(false);
  });

  it("is a function", () => {
    expect(typeof createYoutubeFullSubtitledVideo).toBe("function");
  });

  it("throws when neither boardId nor fileMetaId is provided", async () => {
    const client = new DagloApiClient();
    await expect(
      createYoutubeFullSubtitledVideo(client, {
        youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      })
    ).rejects.toThrow("Provide boardId or fileMetaId to fetch transcript.");
  });

  it("uses board-derived inputs and the new subtitle pipeline for board-only requests", async () => {
    const outputDir = resolve("./docs/full-subtitles");
    const videoPath = resolve(outputDir, "video_dQw4w9WgXcQ.mp4");
    const srtPath = resolve(outputDir, "subtitles.srt");
    const finalPath = resolve(outputDir, "video_with_subs.mp4");
    const existingPaths = new Set<string>();

    existsSyncMock.mockImplementation((targetPath: string) => existingPaths.has(targetPath));
    execSyncMock.mockImplementation((command: string) => {
      if (command.includes("python -m yt_dlp")) {
        existingPaths.add(videoPath);
        return Buffer.from("");
      }

      if (command.startsWith("ffprobe ")) {
        return Buffer.from("12.5\n");
      }

      if (command.startsWith("ffmpeg ")) {
        existingPaths.add(finalPath);
        return Buffer.from("");
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    (global.fetch as any)
      .mockResolvedValueOnce(
        jsonResponse({
          fileMetaId: "fm-full-1",
          nested: {
            source: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          },
        })
      )
      .mockResolvedValueOnce(
        scriptResponse({
          editorState: {
            root: {
              children: [
                {
                  children: [
                    { type: "karaoke", text: "첫 문장입니다.", s: 0, e: 1.5 },
                    { type: "karaoke", text: "둘째 문장입니다.", s: 1.5, e: 3.2 },
                  ],
                },
              ],
            },
          },
        })
      );

    const client = new DagloApiClient();
    const result = (await createYoutubeFullSubtitledVideo(client, {
      boardId: "board-full-1",
    } as any)) as Record<string, unknown>;

    expect((global.fetch as any).mock.calls[0][0]).toContain("/boards/board-full-1");
    expect((global.fetch as any).mock.calls[1][0]).toContain("/file-meta/fm-full-1/script");
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      srtPath,
      [
        "1",
        "00:00:00,000 --> 00:00:01,500",
        "첫 문장입니다.",
        "",
        "2",
        "00:00:01,500 --> 00:00:03,200",
        "둘째 문장입니다.",
        "",
        "",
      ].join("\n"),
      "utf-8"
    );
    expect(execSyncMock).toHaveBeenNthCalledWith(
      1,
      `python -m yt_dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 -o "${videoPath}" "https://www.youtube.com/watch?v=dQw4w9WgXcQ"`,
      { stdio: "inherit" }
    );
    expect(execSyncMock).toHaveBeenNthCalledWith(
      2,
      `ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${videoPath}"`
    );
    expect(execSyncMock).toHaveBeenNthCalledWith(
      3,
      `ffmpeg -y -i "${videoPath}" -vf "subtitles='${srtPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'")}'" -c:a copy "${finalPath}"`,
      { stdio: "inherit" }
    );
    expect(result).toMatchObject({
      success: true,
      outputDir: "./docs/full-subtitles",
      videoPath,
      srtPath,
      finalPath,
      segmentCount: 2,
      videoDuration: 12.5,
      subtitleMaxLineLength: 42,
    });
  });

  it("keeps direct youtubeUrl + fileMetaId mode working without board lookup", async () => {
    const outputDir = resolve("./docs/full-subtitles");
    const videoPath = resolve(outputDir, "video_directhappy1.mp4");
    const srtPath = resolve(outputDir, "subtitles.srt");
    const finalPath = resolve(outputDir, "video_with_subs.mp4");
    const existingPaths = new Set<string>();

    existsSyncMock.mockImplementation((targetPath: string) => existingPaths.has(targetPath));
    execSyncMock.mockImplementation((command: string) => {
      if (command.includes("python -m yt_dlp")) {
        existingPaths.add(videoPath);
        return Buffer.from("");
      }

      if (command.startsWith("ffprobe ")) {
        return Buffer.from("15.75\n");
      }

      if (command.startsWith("ffmpeg ")) {
        existingPaths.add(finalPath);
        return Buffer.from("");
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    (global.fetch as any)
      .mockResolvedValueOnce(
        scriptResponse(
          {
            editorState: {
              root: {
                children: [
                  {
                    children: [{ type: "karaoke", text: "첫 페이지 자막입니다.", s: 0, e: 1.4 }],
                  },
                ],
              },
            },
          },
          2
        )
      )
      .mockResolvedValueOnce(
        scriptResponse({
          editorState: {
            root: {
              children: [
                {
                  children: [{ type: "karaoke", text: "둘째 페이지 자막입니다.", s: 1.4, e: 3.1 }],
                },
              ],
            },
          },
        })
      );

    const client = new DagloApiClient();
    const result = (await createYoutubeFullSubtitledVideo(client, {
      fileMetaId: "fm-direct-1",
      youtubeUrl: "https://www.youtube.com/watch?v=directhappy1",
    } as any)) as Record<string, unknown>;

    expect((global.fetch as any)).toHaveBeenCalledTimes(2);
    expect((global.fetch as any).mock.calls.every(([url]: [string]) => !url.includes("/boards/"))).toBe(true);
    expect((global.fetch as any).mock.calls[0][0]).toContain("/file-meta/fm-direct-1/script?limit=60&page=0");
    expect((global.fetch as any).mock.calls[1][0]).toContain("/file-meta/fm-direct-1/script?limit=60&page=1");
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      srtPath,
      [
        "1",
        "00:00:00,000 --> 00:00:01,399",
        "첫 페이지 자막입니다.",
        "",
        "2",
        "00:00:01,399 --> 00:00:03,100",
        "둘째 페이지 자막입니다.",
        "",
        "",
      ].join("\n"),
      "utf-8"
    );
    expect(result).toMatchObject({
      success: true,
      videoPath,
      srtPath,
      finalPath,
      segmentCount: 2,
      videoDuration: 15.75,
    });
  });

  it("supplements youtubeUrl at runtime for boardId + fileMetaId requests", async () => {
    const outputDir = resolve("./docs/full-subtitles");
    const videoPath = resolve(outputDir, "video_boardfilemeta01.mp4");
    const srtPath = resolve(outputDir, "subtitles.srt");
    const finalPath = resolve(outputDir, "video_with_subs.mp4");
    const existingPaths = new Set<string>();

    existsSyncMock.mockImplementation((targetPath: string) => existingPaths.has(targetPath));
    execSyncMock.mockImplementation((command: string) => {
      if (command.includes("python -m yt_dlp")) {
        existingPaths.add(videoPath);
        return Buffer.from("");
      }

      if (command.startsWith("ffprobe ")) {
        return Buffer.from("14.25\n");
      }

      if (command.startsWith("ffmpeg ")) {
        existingPaths.add(finalPath);
        return Buffer.from("");
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    (global.fetch as any)
      .mockResolvedValueOnce(
        scriptResponse({
          editorState: {
            root: {
              children: [
                {
                  children: [{ type: "karaoke", text: "board + fileMeta 보강", s: 0, e: 2.4 }],
                },
              ],
            },
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          fileMetaId: "fm-board-filemeta-1",
          fileUrl: "https://www.youtube.com/watch?v=boardfilemeta01",
        })
      );

    const client = new DagloApiClient();
    const result = (await createYoutubeFullSubtitledVideo(client, {
      boardId: "board-filemeta-1",
      fileMetaId: "fm-board-filemeta-1",
    } as any)) as Record<string, unknown>;

    expect((global.fetch as any)).toHaveBeenCalledTimes(2);
    expect((global.fetch as any).mock.calls[0][0]).toContain("/file-meta/fm-board-filemeta-1/script?limit=60&page=0");
    expect((global.fetch as any).mock.calls[1][0]).toContain("/boards/board-filemeta-1");
    expect(execSyncMock.mock.calls[0]?.[0]).toContain('"https://www.youtube.com/watch?v=boardfilemeta01"');
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      srtPath,
      ["1", "00:00:00,000 --> 00:00:02,399", "board + fileMeta 보강", "", ""].join("\n"),
      "utf-8"
    );
    expect(result).toMatchObject({
      success: true,
      videoPath,
      srtPath,
      finalPath,
      segmentCount: 1,
      videoDuration: 14.25,
    });
  });

  it("prefers transcript embedded youtube urls over board detail urls", async () => {
    const outputDir = resolve("./docs/full-subtitles");
    const videoPath = resolve(outputDir, "video_scriptwins01.mp4");
    const finalPath = resolve(outputDir, "video_with_subs.mp4");
    const existingPaths = new Set<string>();

    existsSyncMock.mockImplementation((targetPath: string) => existingPaths.has(targetPath));
    execSyncMock.mockImplementation((command: string) => {
      if (command.includes("python -m yt_dlp")) {
        existingPaths.add(videoPath);
        return Buffer.from("");
      }

      if (command.startsWith("ffprobe ")) {
        return Buffer.from("11.0\n");
      }

      if (command.startsWith("ffmpeg ")) {
        existingPaths.add(finalPath);
        return Buffer.from("");
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    (global.fetch as any)
      .mockResolvedValueOnce(
        jsonResponse({
          fileMetaId: "fm-script-priority-1",
          fileUrl: "https://www.youtube.com/watch?v=boardfallback01",
        })
      )
      .mockResolvedValueOnce(
        scriptResponse({
          sourceUrl: "https://www.youtube.com/watch?v=scriptwins01",
          editorState: {
            root: {
              children: [
                {
                  children: [{ type: "karaoke", text: "script url wins", s: 0, e: 1.8 }],
                },
              ],
            },
          },
        })
      );

    const client = new DagloApiClient();
    await createYoutubeFullSubtitledVideo(client, {
      boardId: "board-script-priority-1",
    } as any);

    expect((global.fetch as any)).toHaveBeenCalledTimes(2);
    expect((global.fetch as any).mock.calls[0][0]).toContain("/boards/board-script-priority-1");
    expect((global.fetch as any).mock.calls[1][0]).toContain("/file-meta/fm-script-priority-1/script?limit=60&page=0");
    expect(execSyncMock.mock.calls[0]?.[0]).toContain('"https://www.youtube.com/watch?v=scriptwins01"');
    expect(execSyncMock.mock.calls[0]?.[0]).not.toContain("boardfallback01");
  });

  it("resolves board-only mode with fileMeta fallback while ignoring Daglo share urls", async () => {
    const outputDir = resolve("./docs/full-subtitles");
    const videoPath = resolve(outputDir, "video_boardonly01.mp4");
    const srtPath = resolve(outputDir, "subtitles.srt");
    const finalPath = resolve(outputDir, "video_with_subs.mp4");
    const existingPaths = new Set<string>();

    existsSyncMock.mockImplementation((targetPath: string) => existingPaths.has(targetPath));
    execSyncMock.mockImplementation((command: string) => {
      if (command.includes("python -m yt_dlp")) {
        existingPaths.add(videoPath);
        return Buffer.from("");
      }

      if (command.startsWith("ffprobe ")) {
        return Buffer.from("9.5\n");
      }

      if (command.startsWith("ffmpeg ")) {
        existingPaths.add(finalPath);
        return Buffer.from("");
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    (global.fetch as any)
      .mockResolvedValueOnce(
        jsonResponse({
          fileMeta: [{ id: "fm-board-only-1" }],
          shareUrl: { url: "https://daglo.ai/share/ignored-share" },
          fileUrl: "https://www.youtube.com/watch?v=boardonly01",
        })
      )
      .mockResolvedValueOnce(
        scriptResponse({
          editorState: {
            root: {
              children: [
                {
                  children: [{ type: "karaoke", text: "board only 성공 경로", s: 0, e: 2.2 }],
                },
              ],
            },
          },
        })
      );

    const client = new DagloApiClient();
    const result = (await createYoutubeFullSubtitledVideo(client, {
      boardId: "board-only-1",
    } as any)) as Record<string, unknown>;

    expect((global.fetch as any).mock.calls[0][0]).toContain("/boards/board-only-1");
    expect((global.fetch as any).mock.calls[1][0]).toContain("/file-meta/fm-board-only-1/script");
    expect(execSyncMock.mock.calls[0]?.[0]).toContain('"https://www.youtube.com/watch?v=boardonly01"');
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      srtPath,
      ["1", "00:00:00,000 --> 00:00:02,200", "board only 성공 경로", "", ""].join("\n"),
      "utf-8"
    );
    expect(result).toMatchObject({
      success: true,
      videoPath,
      srtPath,
      finalPath,
      segmentCount: 1,
      videoDuration: 9.5,
    });
  });

  it("fails board-only mode before script fetch when no youtube url is resolvable", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      jsonResponse({
        fileMetaId: "fm-no-url-1",
        shareUrl: { url: "https://daglo.ai/share/only-share-url" },
        nested: { note: "still no usable video source" },
      })
    );

    const client = new DagloApiClient();
    await expect(
      createYoutubeFullSubtitledVideo(client, {
        boardId: "board-no-url-1",
      } as any)
    ).rejects.toThrow("No YouTube URL found for board board-no-url-1.");

    expect((global.fetch as any)).toHaveBeenCalledTimes(1);
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("fails board-only mode before script fetch when multiple youtube urls are found", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      jsonResponse({
        fileMetaId: "fm-multi-url-1",
        sources: [
          "https://youtu.be/abc123xyz99",
          { nested: "https://www.youtube.com/watch?v=multiurl002" },
        ],
      })
    );

    const client = new DagloApiClient();
    await expect(
      createYoutubeFullSubtitledVideo(client, {
        boardId: "board-multi-url-1",
      } as any)
    ).rejects.toThrow(
      "Multiple YouTube URLs found for board board-multi-url-1: https://youtu.be/abc123xyz99, https://www.youtube.com/watch?v=multiurl002"
    );

    expect((global.fetch as any)).toHaveBeenCalledTimes(1);
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("fails before download when transcript normalization yields no usable segments", async () => {
    (global.fetch as any).mockResolvedValueOnce(
      scriptResponse({
        editorState: {
          root: {
            children: [
              {
                children: [{ type: "karaoke", text: "   ", s: 2, e: 1 }],
              },
            ],
          },
        },
      })
    );

    const client = new DagloApiClient();
    await expect(
      createYoutubeFullSubtitledVideo(client, {
        fileMetaId: "fm-invalid-segments-1",
        youtubeUrl: "https://www.youtube.com/watch?v=invalidseg01",
      } as any)
    ).rejects.toThrow("No usable subtitle segments after normalization.");

    expect(execSyncMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("does not enter ffmpeg when yt-dlp download fails", async () => {
    execSyncMock.mockImplementation((command: string) => {
      if (command.includes("python -m yt_dlp")) {
        throw new Error("yt-dlp failed");
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    (global.fetch as any).mockResolvedValueOnce(
      scriptResponse({
        editorState: {
          root: {
            children: [
              {
                children: [{ type: "karaoke", text: "다운로드 실패 테스트", s: 0, e: 2 }],
              },
            ],
          },
        },
      })
    );

    const client = new DagloApiClient();
    await expect(
      createYoutubeFullSubtitledVideo(client, {
        fileMetaId: "fm-full-2",
        youtubeUrl: "https://www.youtube.com/watch?v=failcase001",
      } as any)
    ).rejects.toThrow("yt-dlp failed");

    expect(execSyncMock).toHaveBeenCalledTimes(1);
    expect(execSyncMock.mock.calls[0]?.[0]).toContain("python -m yt_dlp");
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      resolve("./docs/full-subtitles", "subtitles.srt"),
      expect.stringContaining("다운로드 실패 테스트"),
      "utf-8"
    );
  });

  it("keeps the srt file when ffmpeg burning fails", async () => {
    const outputDir = resolve("./docs/full-subtitles");
    const videoPath = resolve(outputDir, "video_ffmpegfail01.mp4");
    const srtPath = resolve(outputDir, "subtitles.srt");
    const existingPaths = new Set<string>();

    existsSyncMock.mockImplementation((targetPath: string) => existingPaths.has(targetPath));
    execSyncMock.mockImplementation((command: string) => {
      if (command.includes("python -m yt_dlp")) {
        existingPaths.add(videoPath);
        return Buffer.from("");
      }

      if (command.startsWith("ffprobe ")) {
        return Buffer.from("8.0\n");
      }

      if (command.startsWith("ffmpeg ")) {
        throw new Error("ffmpeg failed");
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    (global.fetch as any).mockResolvedValueOnce(
      scriptResponse({
        editorState: {
          root: {
            children: [
              {
                children: [{ type: "karaoke", text: "ffmpeg 실패 테스트", s: 0, e: 2 }],
              },
            ],
          },
        },
      })
    );

    const client = new DagloApiClient();
    await expect(
      createYoutubeFullSubtitledVideo(client, {
        fileMetaId: "fm-full-3",
        youtubeUrl: "https://www.youtube.com/watch?v=ffmpegfail01",
      } as any)
    ).rejects.toThrow("ffmpeg failed");

    expect(writeFileSyncMock).toHaveBeenCalledWith(
      srtPath,
      expect.stringContaining("ffmpeg 실패 테스트"),
      "utf-8"
    );
    expect(execSyncMock).toHaveBeenCalledTimes(3);
    expect(execSyncMock.mock.calls[2]?.[0]).toContain("ffmpeg -y -i");
  });
});

describe("buildCues", () => {
  const makeScript = (tokens: Array<{ text: string; s: number; e: number }>) => ({
    editorState: {
      root: {
        children: [
          {
            children: tokens.map((token) => ({ type: "karaoke", ...token })),
          },
        ],
      },
    },
  });

  it("deduplicates overlapping script pages so the transcript is not doubled", () => {
    // Two pages where the second repeats the first's content with identical timestamps —
    // exactly the Daglo paginated-script behavior that doubled the burned-in subtitles.
    const page = makeScript([
      { text: "A hundred million dollars. ", s: 12.7, e: 14.2 },
      { text: "Would you take it? ", s: 14.8, e: 17.5 },
      { text: "We will survive. ", s: 17.6, e: 19.5 },
    ]);

    const { cues } = buildCues([page, page], 42);
    const joined = cues.map((cue) => cue.text.replace(/\n/g, " ")).join(" ");

    expect(joined).toContain("A hundred million dollars.");
    // The phrase must appear exactly once, not once per duplicated page.
    expect(joined.match(/A hundred million dollars\./g)).toHaveLength(1);
  });

  it("keeps genuinely repeated phrases that carry distinct timestamps", () => {
    const script = makeScript([
      { text: "I can do better. ", s: 1.6, e: 2.4 },
      { text: "I can do better. ", s: 3.2, e: 4.0 },
    ]);

    const { cues } = buildCues([script], 42);
    const joined = cues.map((cue) => cue.text.replace(/\n/g, " ")).join(" ");

    expect(joined.match(/I can do better\./g)).toHaveLength(2);
  });
});
