import * as z from "zod";

const youtubeSourceFields = {
  boardId: z.string().optional().describe("Board ID to fetch transcript from"),
  fileMetaId: z
    .string()
    .optional()
    .describe("File metadata ID to fetch script from (takes precedence over boardId)"),
  outputDir: z
    .string()
    .optional()
    .describe("Output directory for generated files (default: ./docs/clips)"),
  clipLengthMinutes: z
    .number()
    .optional()
    .describe("Target clip length in minutes (default: 3.5)"),
  subtitleMaxLineLength: z
    .number()
    .optional()
    .describe("Max characters per subtitle segment (default: 42)"),
};

export const createYoutubeHighlightClipSchema = z.object({
  youtubeUrl: z.string().describe("YouTube video URL to download"),
  ...youtubeSourceFields,
  shortsMode: z
    .boolean()
    .optional()
    .describe("Generate vertical 9:16 clip for shorts (default: false)"),
  highlightKeywords: z
    .array(z.string())
    .optional()
    .describe("Keywords to identify highlight segments (default: from board keywords)"),
});

export type CreateYoutubeHighlightClipArgs = z.infer<typeof createYoutubeHighlightClipSchema>;

const createYoutubeFullSubtitledVideoSourceSchema = z
  .object({
    youtubeUrl: z.string().optional().describe("YouTube video URL to download"),
    ...youtubeSourceFields,
  })
  .superRefine((args, ctx) => {
    if (args.fileMetaId && !args.boardId && !args.youtubeUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fileMetaId"],
        message:
          "Provide <youtubeUrl> when using --file-meta without --board-id.",
      });
      return;
    }

    if (!args.youtubeUrl && !args.boardId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["youtubeUrl"],
        message: "Provide <youtubeUrl> or --board-id to resolve video source.",
      });
    }
  });

export const createYoutubeFullSubtitledVideoSchema = createYoutubeFullSubtitledVideoSourceSchema;

export const createYoutubeFullSubtitledVideoCommandSchema =
  createYoutubeFullSubtitledVideoSourceSchema;

export type CreateYoutubeFullSubtitledVideoCommandArgs = z.infer<
  typeof createYoutubeFullSubtitledVideoCommandSchema
>;

export type CreateYoutubeFullSubtitledVideoArgs = z.infer<
  typeof createYoutubeFullSubtitledVideoSchema
>;
