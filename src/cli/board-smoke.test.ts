import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const cliPath = resolve(process.cwd(), "dist/cli.js");
const smokeEvidenceRoot = resolve(process.cwd(), ".sisyphus/evidence");
const boardEvidenceRoot = resolve(smokeEvidenceRoot, "task-8-board");
const boardEvidenceLogPath = resolve(smokeEvidenceRoot, "task-8-board.log");
const directUrlEvidenceRoot = resolve(smokeEvidenceRoot, "task-8-direct-url-file-meta");
const cliSmokeEvidenceRoot = resolve(smokeEvidenceRoot, "task-8-cli-smoke");

const writeExecutable = (filePath: string, contents: string) => {
  writeFileSync(filePath, contents, "utf8");
  chmodSync(filePath, 0o755);
};

const clearEvidenceDir = (dirPath: string) => {
  mkdirSync(dirPath, { recursive: true });

  for (const entry of readdirSync(dirPath)) {
    const entryPath = resolve(dirPath, entry);
    if (existsSync(entryPath)) {
      rmSync(entryPath, { recursive: true, force: true });
    }
  }
};

const writeSmokeEvidence = (fileName: string, content: string) => {
  mkdirSync(cliSmokeEvidenceRoot, { recursive: true });
  writeFileSync(resolve(cliSmokeEvidenceRoot, fileName), content, "utf8");
};

const writeBuiltCliLog = (filePath: string, stdout: string, stderr: string) => {
  const sections = [
    "[stdout]",
    stdout || "<empty>",
    "",
    "[stderr]",
    stderr || "<empty>",
    "",
  ];
  writeFileSync(filePath, sections.join("\n"), "utf8");
};

const runBuiltCli = (args: string[], env: NodeJS.ProcessEnv = {}) => {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      ...env,
    },
  });

  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
};

const setupBuiltCliSmoke = (options: {
  sandboxRoot: string;
  outputDir: string;
  boardId: string;
  fileMetaId: string;
  videoId: string;
  boardBody: Record<string, unknown>;
  scriptBodies: Array<Record<string, unknown>>;
  ffprobeEvidencePath?: string;
}) => {
  const binDir = resolve(options.sandboxRoot, "bin");
  const preloadPath = resolve(options.sandboxRoot, "board-smoke-preload.mjs");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(options.outputDir, { recursive: true });

  const pythonPath = resolve(binDir, "python");
  const ffprobePath = resolve(binDir, "ffprobe");
  const ffmpegPath = resolve(binDir, "ffmpeg");

  writeExecutable(
    pythonPath,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] !== "-m" || args[1] !== "yt_dlp") {
  process.exit(2);
}

const outputIndex = args.indexOf("-o");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : "";
if (!outputPath) {
  process.exit(3);
}

writeFileSync(outputPath, "video", "utf8");
`
  );

  writeExecutable(
    ffprobePath,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const output = "12.5\\n";
if (process.env.DAGLO_FFPROBE_EVIDENCE_PATH) {
  writeFileSync(process.env.DAGLO_FFPROBE_EVIDENCE_PATH, output, "utf8");
}
process.stdout.write(output);
`
  );

  writeExecutable(
    ffmpegPath,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const outputPath = args[args.length - 1];
if (!outputPath) {
  process.exit(2);
}

writeFileSync(outputPath, "final", "utf8");
`
  );

  writeFileSync(
    preloadPath,
    `const boardId = ${JSON.stringify(options.boardId)};
const fileMetaId = ${JSON.stringify(options.fileMetaId)};
const boardBody = ${JSON.stringify(options.boardBody)};
const scriptBodies = ${JSON.stringify(options.scriptBodies)};

globalThis.fetch = async (input) => {
  const url = new URL(String(input));

  if (url.pathname === "/boards/" + boardId) {
    return new Response(JSON.stringify(boardBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  if (url.pathname === "/file-meta/" + fileMetaId + "/script") {
    const page = Number(url.searchParams.get("page") ?? "0");
    const body = scriptBodies[page];
    if (!body) {
      throw new Error("Unexpected script page: " + url.href);
    }

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  throw new Error("Unexpected fetch: " + url.href);
};
`,
    "utf8"
  );

  return {
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      NODE_OPTIONS: `--import ${pathToFileURL(preloadPath).href}`,
      ...(options.ffprobeEvidencePath
        ? { DAGLO_FFPROBE_EVIDENCE_PATH: options.ffprobeEvidencePath }
        : {}),
    },
    videoPath: resolve(options.outputDir, `video_${options.videoId}.mp4`),
    srtPath: resolve(options.outputDir, "subtitles.srt"),
    finalPath: resolve(options.outputDir, "video_with_subs.mp4"),
  };
};

describe("board-id CLI smoke contract", () => {
  beforeAll(() => {
    rmSync(boardEvidenceLogPath, { recursive: true, force: true });
    clearEvidenceDir(boardEvidenceRoot);
    clearEvidenceDir(directUrlEvidenceRoot);
    clearEvidenceDir(cliSmokeEvidenceRoot);
  });

  it("fails file-meta only requests through the built CLI with the expected message", () => {
    expect(existsSync(cliPath)).toBe(true);

    const result = runBuiltCli([
      "video",
      "subtitle",
      "--file-meta",
      "fm-smoke-1",
    ]);

    writeSmokeEvidence("file-meta-only.stderr.log", result.stderr);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Provide <youtubeUrl> when using --file-meta without --board-id."
    );
  });

  it("keeps the built CLI board-id happy path pinned to task-8 board evidence", () => {
    const videoId = "boardhappy01";
    const ffprobeEvidencePath = resolve(cliSmokeEvidenceRoot, "board-id-happy.ffprobe.txt");
    const { env, videoPath, srtPath, finalPath } = setupBuiltCliSmoke({
      sandboxRoot: resolve(cliSmokeEvidenceRoot, "board-id-happy-runtime"),
      outputDir: boardEvidenceRoot,
      boardId: "board-happy-1",
      fileMetaId: "fm-happy-1",
      videoId: "boardhappy01",
      ffprobeEvidencePath,
      boardBody: {
        fileMetaId: "fm-happy-1",
        nested: {
          source: `https://www.youtube.com/watch?v=${videoId}`,
        },
      },
      scriptBodies: [
        {
          item: JSON.stringify({
            editorState: {
              root: {
                children: [
                  {
                    children: [
                      { type: "karaoke", text: "board smoke happy path", s: 0, e: 2.5 },
                    ],
                  },
                ],
              },
            },
          }),
          meta: { totalPages: 1 },
        },
      ],
    });

    const result = runBuiltCli(
      ["video", "subtitle", "--board-id", "board-happy-1", "--out", boardEvidenceRoot],
      env
    );

    writeSmokeEvidence("happy-path.stderr.log", result.stderr);
    writeSmokeEvidence("happy-path.stdout.log", result.stdout);
    writeBuiltCliLog(boardEvidenceLogPath, result.stdout, result.stderr);

    expect(result.ok).toBe(true);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`✓ Wrote: ${srtPath}`);
    expect(result.stderr).toContain(`✓ Wrote: ${videoPath}`);
    expect(result.stderr).toContain(`✓ Wrote: ${finalPath}`);
    expect(existsSync(srtPath)).toBe(true);
    expect(existsSync(videoPath)).toBe(true);
    expect(existsSync(finalPath)).toBe(true);
    expect(readFileSync(ffprobeEvidencePath, "utf8")).toBe("12.5\n");
  });

  it("keeps the built CLI direct youtubeUrl + fileMeta regression smoke separate from board-id evidence", () => {
    const videoId = "directsmoke01";
    const { env, videoPath, srtPath, finalPath } = setupBuiltCliSmoke({
      sandboxRoot: resolve(cliSmokeEvidenceRoot, "direct-url-file-meta-runtime"),
      outputDir: directUrlEvidenceRoot,
      boardId: "unused-board-id",
      fileMetaId: "fm-direct-smoke-1",
      videoId,
      ffprobeEvidencePath: resolve(cliSmokeEvidenceRoot, "direct-url-file-meta.ffprobe.txt"),
      boardBody: {},
      scriptBodies: [
        {
          item: JSON.stringify({
            editorState: {
              root: {
                children: [
                  {
                    children: [
                      { type: "karaoke", text: "direct url file meta smoke", s: 0, e: 2.2 },
                    ],
                  },
                ],
              },
            },
          }),
          meta: { totalPages: 1 },
        },
      ],
    });

    const result = runBuiltCli(
      [
        "video",
        "subtitle",
        "--file-meta",
        "fm-direct-smoke-1",
        "--out",
        directUrlEvidenceRoot,
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      env
    );

    writeSmokeEvidence("direct-url-file-meta.stderr.log", result.stderr);
    writeSmokeEvidence("direct-url-file-meta.stdout.log", result.stdout);

    expect(result.ok).toBe(true);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`✓ Wrote: ${srtPath}`);
    expect(result.stderr).toContain(`✓ Wrote: ${videoPath}`);
    expect(result.stderr).toContain(`✓ Wrote: ${finalPath}`);
    expect(existsSync(srtPath)).toBe(true);
    expect(existsSync(videoPath)).toBe(true);
    expect(existsSync(finalPath)).toBe(true);
    expect(readFileSync(resolve(cliSmokeEvidenceRoot, "direct-url-file-meta.ffprobe.txt"), "utf8")).toBe(
      "12.5\n"
    );
  });

  it("keeps the built CLI board-id regression path failing early when multiple YouTube URLs exist", () => {
    const multiUrlOutputDir = resolve(boardEvidenceRoot, "multi-url");
    const { env, srtPath, videoPath, finalPath } = setupBuiltCliSmoke({
      sandboxRoot: resolve(cliSmokeEvidenceRoot, "multi-url-runtime"),
      outputDir: multiUrlOutputDir,
      boardId: "board-multi-1",
      fileMetaId: "fm-multi-1",
      videoId: "boardmulti01",
      boardBody: {
        fileMetaId: "fm-multi-1",
        sources: [
          "https://youtu.be/abc123xyz99",
          { nested: "https://www.youtube.com/watch?v=multiurl002" },
        ],
      },
      scriptBodies: [],
    });

    const result = runBuiltCli(
      ["video", "subtitle", "--board-id", "board-multi-1", "--out", multiUrlOutputDir],
      env
    );

    writeSmokeEvidence("multi-url.stderr.log", result.stderr);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Multiple YouTube URLs found for board board-multi-1: https://youtu.be/abc123xyz99, https://www.youtube.com/watch?v=multiurl002"
    );
    expect(result.stderr).not.toContain("Wrote:");
    expect(existsSync(srtPath)).toBe(false);
    expect(existsSync(videoPath)).toBe(false);
    expect(existsSync(finalPath)).toBe(false);
  });

  it("fails board-only requests through the built CLI before script download when no youtube url exists", () => {
    const outputDir = resolve(boardEvidenceRoot, "no-url");
    const { env, srtPath, videoPath, finalPath } = setupBuiltCliSmoke({
      sandboxRoot: resolve(cliSmokeEvidenceRoot, "no-url-runtime"),
      outputDir,
      boardId: "board-no-url-smoke",
      fileMetaId: "fm-no-url-1",
      videoId: "unused-no-url",
      boardBody: {
        fileMetaId: "fm-no-url-1",
        shareUrl: { url: "https://daglo.ai/share/only-share" },
        nested: { title: "still no usable youtube url" },
      },
      scriptBodies: [],
    });

    const result = runBuiltCli(
      ["video", "subtitle", "--board-id", "board-no-url-smoke", "--out", outputDir],
      env
    );

    writeSmokeEvidence("no-url.stderr.log", result.stderr);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No YouTube URL found for board board-no-url-smoke.");
    expect(result.stderr).not.toContain("Wrote:");
    expect(existsSync(srtPath)).toBe(false);
    expect(existsSync(videoPath)).toBe(false);
    expect(existsSync(finalPath)).toBe(false);
  });

  it("fails board-only requests through the built CLI when transcript normalization yields no usable segments", () => {
    const outputDir = resolve(boardEvidenceRoot, "empty-transcript");
    const { env, srtPath, videoPath, finalPath } = setupBuiltCliSmoke({
      sandboxRoot: resolve(cliSmokeEvidenceRoot, "empty-transcript-runtime"),
      outputDir,
      boardId: "board-empty-1",
      fileMetaId: "fm-empty-1",
      videoId: "boardempty1",
      boardBody: {
        fileMetaId: "fm-empty-1",
        nested: {
          source: "https://www.youtube.com/watch?v=boardempty1",
        },
      },
      scriptBodies: [
        {
          item: JSON.stringify({
            editorState: {
              root: {
                children: [
                  {
                    children: [{ type: "karaoke", text: "   ", s: 0, e: 0.5 }],
                  },
                ],
              },
            },
          }),
          meta: { totalPages: 1 },
        },
      ],
    });

    const result = runBuiltCli(
      ["video", "subtitle", "--board-id", "board-empty-1", "--out", outputDir],
      env
    );

    writeSmokeEvidence("empty-transcript.stderr.log", result.stderr);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No usable subtitle segments after normalization.");
    expect(result.stderr).not.toContain("Wrote:");
    expect(existsSync(srtPath)).toBe(false);
    expect(existsSync(videoPath)).toBe(false);
    expect(existsSync(finalPath)).toBe(false);
  });
});
