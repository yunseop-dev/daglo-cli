import { Command } from "commander";
import { DagloApiClient } from "../api/client.js";
import {
  createYoutubeFullSubtitledVideo,
  createYoutubeHighlightClip,
} from "../handlers/video.js";
import {
  createYoutubeFullSubtitledVideoCommandSchema,
} from "../schemas/video.js";
import { writeJson, writeFilesWritten } from "./render/format.js";

const splitCsv = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const registerVideoCommand = (
  program: Command,
  client: DagloApiClient
) => {
  const video = program.command("video").description("Video commands");

  video
    .command("clip <youtubeUrl>")
    .description("Generate a YouTube highlight clip with burned-in subtitles")
    .option("--board-id <id>", "board ID")
    .option("--file-meta <id>", "file metadata ID")
    .option("--out <dir>", "output directory", "./docs/clips")
    .option(
      "--length <minutes>",
      "target clip length in minutes",
      (v) => parseFloat(v),
      3.5
    )
    .option(
      "--max-line <chars>",
      "max characters per subtitle segment",
      (v) => parseInt(v, 10),
      42
    )
    .option("--shorts", "vertical 9:16 output")
    .option("--keywords <list>", "comma-separated keywords", splitCsv)
    .option("--json", "output JSON")
    .action(async (youtubeUrl, opts) => {
      const data = (await createYoutubeHighlightClip(client, {
        youtubeUrl,
        boardId: opts.boardId,
        fileMetaId: opts.fileMeta,
        outputDir: opts.out,
        clipLengthMinutes: opts.length,
        subtitleMaxLineLength: opts.maxLine,
        shortsMode: !!opts.shorts,
        highlightKeywords: opts.keywords,
      })) as Record<string, unknown>;

      if (opts.json) return writeJson(data);
      const files = [
        data.videoPath,
        data.clipPath,
        data.srtPath,
        data.finalPath,
      ].filter((p): p is string => typeof p === "string");
      writeFilesWritten(files);
    });

  video
    .command("subtitle [youtubeUrl]")
    .description("Burn full transcript subtitles into a YouTube video")
    .option("--board-id <id>", "board ID")
    .option("--file-meta <id>", "file metadata ID")
    .option("--out <dir>", "output directory", "./docs/full-subtitles")
    .option(
      "--max-line <chars>",
      "max characters per subtitle segment",
      (v) => parseInt(v, 10),
      42
    )
    .option("--json", "output JSON")
    .action(async (youtubeUrl, opts) => {
      const args = createYoutubeFullSubtitledVideoCommandSchema.parse({
        youtubeUrl,
        boardId: opts.boardId,
        fileMetaId: opts.fileMeta,
        outputDir: opts.out,
        subtitleMaxLineLength: opts.maxLine,
      });

      const data = (await createYoutubeFullSubtitledVideo(client, {
        youtubeUrl: args.youtubeUrl as string,
        boardId: args.boardId,
        fileMetaId: args.fileMetaId,
        outputDir: args.outputDir,
        subtitleMaxLineLength: args.subtitleMaxLineLength,
      })) as Record<string, unknown>;

      if (opts.json) return writeJson(data);
      const files = [
        data.videoPath,
        data.srtPath,
        data.finalPath,
      ].filter((p): p is string => typeof p === "string");
      writeFilesWritten(files);
    });
};
