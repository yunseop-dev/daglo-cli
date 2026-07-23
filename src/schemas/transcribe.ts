import * as z from "zod";

export const transcribeSchema = z.object({
  files: z
    .array(z.string())
    .min(1)
    .describe("Local audio/video file paths to upload and transcribe"),
  language: z
    .string()
    .optional()
    .describe("Transcription language code (default: account setting, e.g. ko-KR)"),
  topic: z
    .string()
    .optional()
    .describe("Transcription topic enum (default: account setting, e.g. MEDICINE)"),
  useSpeakerDiarization: z
    .boolean()
    .optional()
    .describe("Enable speaker diarization (default: account setting)"),
  useDictionary: z
    .boolean()
    .optional()
    .describe("Use custom dictionary/glossary (default: account setting)"),
  folder: z
    .string()
    .optional()
    .describe("Target folder name or id (default: 기본 폴더)"),
});

export type TranscribeArgs = z.infer<typeof transcribeSchema>;
