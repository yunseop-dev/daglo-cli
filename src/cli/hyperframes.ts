import { Command } from "commander";
import { DagloApiClient } from "../api/client.js";
import { generateHyperframesProject } from "../handlers/hyperframes.js";
import { writeJson, writeFilesWritten } from "./render/format.js";

export const registerHyperframesCommand = (
  program: Command,
  client: DagloApiClient
) => {
  const hyperframes = program
    .command("hyperframes")
    .description("HyperFrames composition generator");

  hyperframes
    .command("generate <boardId>")
    .description(
      "Generate a HyperFrames project from a Daglo board (transcript + audio + screenshots)"
    )
    .option("-o, --out <dir>", "output directory (default: hyperframes/<slug>)")
    .option("--file-meta <id>", "file metadata ID override")
    .option("--youtube-url <url>", "YouTube URL override")
    .option("--source-video <path>", "use a local video file instead of yt-dlp")
    .option("--source-audio <path>", "use a local audio file instead of ffmpeg extraction")
    .option("--title <text>", "override the composition title")
    .option(
      "--shots <n>",
      "number of screenshots to extract (default: 4)",
      (v) => parseInt(v, 10),
      4
    )
    .option(
      "--max-line <chars>",
      "max characters per subtitle line (default: 42)",
      (v) => parseInt(v, 10),
      42
    )
    .option(
      "--baseline",
      "also write the legacy static index.html (off by default; brief-only)"
    )
    .option("--skip-init", "skip 'hyperframes init' (only meaningful with --baseline)")
    .option("--json", "output JSON")
    .action(async (boardId: string, opts) => {
      const result = await generateHyperframesProject(client, {
        boardId,
        fileMetaId: opts.fileMeta,
        youtubeUrl: opts.youtubeUrl,
        sourceVideo: opts.sourceVideo,
        sourceAudio: opts.sourceAudio,
        outputDir: opts.out,
        title: opts.title,
        shots: opts.shots,
        subtitleMaxLineLength: opts.maxLine,
        skipInit: !!opts.skipInit,
        baseline: !!opts.baseline,
      });

      if (opts.json) return writeJson(result);

      const candidates = [
        result.briefPath,
        result.designPath,
        result.manifestPath,
        result.captionsPath,
        result.transcriptPath,
        result.audioPath,
        result.videoPath,
        result.indexHtml,
        ...result.screenshotPaths,
      ].filter((p): p is string => typeof p === "string");
      const files = candidates.filter((p) => p.startsWith(result.outputDir));
      writeFilesWritten(files);

      process.stdout.write("\nNext steps:\n");
      for (const line of result.followUp) {
        process.stdout.write(`  ${line}\n`);
      }
    });
};
