import { Command } from "commander";
import { DagloApiClient } from "../api/client.js";
import { transcribeFiles } from "../handlers/transcribe.js";
import { transcribeSchema } from "../schemas/transcribe.js";
import { writeJson, writeSuccess } from "./render/format.js";
import { writeTable } from "./render/table.js";

export const registerTranscribeCommand = (
  program: Command,
  client: DagloApiClient
) => {
  program
    .command("transcribe <files...>")
    .description("Upload audio/video file(s) and request transcription (받아쓰기)")
    .option("--language <code>", "language code (default: account setting, e.g. ko-KR)")
    .option("--topic <topic>", "topic enum (default: account setting, e.g. MEDICINE)")
    .option("--speaker", "enable speaker diarization (default: account setting)")
    .option("--no-speaker", "disable speaker diarization")
    .option("--dictionary", "use custom dictionary/glossary (default: account setting)")
    .option("--no-dictionary", "do not use custom dictionary/glossary")
    .option("--folder <name|id>", "target folder name or id (default: 기본 폴더)")
    .option("--json", "output JSON")
    .action(async (files: string[], opts) => {
      const args = transcribeSchema.parse({
        files,
        language: opts.language,
        topic: opts.topic,
        useSpeakerDiarization: opts.speaker,
        useDictionary: opts.dictionary,
        folder: opts.folder,
      });

      const result = await transcribeFiles(client, args);

      if (opts.json) return writeJson(result);

      writeTable(result.files, [
        { header: "NAME", get: (r) => String(r.name ?? "") },
        { header: "FILE META ID", get: (r) => String(r.fileMetaId ?? "") },
        {
          header: "DURATION",
          get: (r) => (r.duration != null ? `${Number(r.duration).toFixed(1)}s` : ""),
        },
      ]);

      const summary = result.boardId
        ? `Transcription requested — boardId ${result.boardId} (${result.fileMetaIds.length} file(s))`
        : `Transcription requested for ${result.fileMetaIds.length} file(s)`;
      writeSuccess(summary);
      if (result.folderId) {
        writeSuccess(`Folder: ${result.folderId}`);
      }
      writeSuccess(
        `Options: language=${result.options.language}, topic=${result.options.topic}, ` +
          `speaker=${result.options.useSpeakerDiarization}, dictionary=${result.options.useDictionary}`
      );
      writeSuccess(
        result.boardId
          ? `Check result with: daglo board detail ${result.boardId} --file-meta ${result.fileMetaIds[0]}`
          : `Check result with: daglo board script --file-meta ${result.fileMetaIds[0]}`
      );
    });
};
