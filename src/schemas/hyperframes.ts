import * as z from "zod";

export const generateHyperframesSchema = z.object({
  boardId: z.string().describe("Board ID to fetch transcript from"),
  fileMetaId: z
    .string()
    .optional()
    .describe("File metadata ID override (otherwise resolved from board)"),
  youtubeUrl: z
    .string()
    .optional()
    .describe("YouTube URL override (otherwise resolved from board metadata)"),
  sourceVideo: z
    .string()
    .optional()
    .describe("Path to a local video file (skip yt-dlp download)"),
  sourceAudio: z
    .string()
    .optional()
    .describe("Path to a local audio file (skip ffmpeg audio extraction)"),
  outputDir: z
    .string()
    .optional()
    .describe("Output directory (default: hyperframes/<board-slug>)"),
  title: z.string().optional().describe("Override the composition title"),
  shots: z
    .number()
    .int()
    .min(0)
    .max(8)
    .optional()
    .describe("Number of screenshots to extract (default: 4)"),
  subtitleMaxLineLength: z
    .number()
    .optional()
    .describe("Max characters per subtitle line (default: 42)"),
  skipInit: z
    .boolean()
    .optional()
    .describe("Skip running 'hyperframes init' even if the CLI is available"),
  baseline: z
    .boolean()
    .optional()
    .describe("Also write the legacy static index.html template (off by default)"),
});

export type GenerateHyperframesArgs = z.infer<typeof generateHyperframesSchema>;
