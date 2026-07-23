#!/usr/bin/env node
import chalk from "chalk";
import { Command } from "commander";
import { DagloApiClient } from "./api/client.js";
import { registerAuthCommand } from "./cli/auth.js";
import { registerBoardCommand } from "./cli/board.js";
import { registerFolderCommand } from "./cli/folder.js";
import { registerFileMetaCommand } from "./cli/file-meta.js";
import { registerObsidianCommand } from "./cli/obsidian.js";
import { registerVideoCommand } from "./cli/video.js";
import { registerHyperframesCommand } from "./cli/hyperframes.js";
import { registerTranscribeCommand } from "./cli/transcribe.js";
import { logger } from "./logger.js";
import { writeError } from "./cli/render/format.js";

const program = new Command();
const client = new DagloApiClient();

program
  .name("daglo")
  .description("Daglo CLI — speech-to-text and document management")
  .version("1.0.0")
  .option("-v, --verbose", "enable debug logging")
  .option("--quiet", "suppress info logs")
  .option("--no-color", "disable color output")
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.verbose) (logger as unknown as { level: string }).level = "debug";
    if (opts.quiet) (logger as unknown as { level: string }).level = "warn";
    if (opts.color === false) chalk.level = 0;
  });

registerAuthCommand(program, client);
registerBoardCommand(program, client);
registerFolderCommand(program, client);
registerFileMetaCommand(program, client);
registerObsidianCommand(program, client);
registerVideoCommand(program, client);
registerHyperframesCommand(program, client);
registerTranscribeCommand(program, client);

program.parseAsync(process.argv).catch((err: Error) => {
  writeError(err.message);
  process.exit(1);
});
