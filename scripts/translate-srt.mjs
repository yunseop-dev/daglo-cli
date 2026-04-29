#!/usr/bin/env node
// Translate an English SRT file to Korean using `claude -p` (Claude Code CLI headless).
// Preserves SRT block structure (index, timestamp, text). Chunks by cue count to keep
// each model call small and resilient.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, basename, extname } from "node:path";

const [, , inputPath, outputPath, chunkSizeArg] = process.argv;
if (!inputPath) {
  console.error("usage: translate-srt.mjs <input.srt> [output.srt] [chunkSize]");
  process.exit(1);
}

const outPath =
  outputPath ??
  resolve(
    dirname(inputPath),
    `${basename(inputPath, extname(inputPath))}.ko.srt`
  );
const chunkSize = Number.parseInt(chunkSizeArg ?? "80", 10);

const raw = readFileSync(inputPath, "utf-8").replace(/\r\n/g, "\n");
// Split into cue blocks separated by blank lines.
const blocks = raw.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
console.log(`cues: ${blocks.length}, chunkSize: ${chunkSize}`);

const chunks = [];
for (let i = 0; i < blocks.length; i += chunkSize) {
  chunks.push(blocks.slice(i, i + chunkSize));
}

const progressPath = `${outPath}.progress.json`;
let progress = { done: [] };
if (existsSync(progressPath)) {
  try {
    progress = JSON.parse(readFileSync(progressPath, "utf-8"));
  } catch {
    progress = { done: [] };
  }
}

const SYSTEM = `You are a professional subtitle translator.
Task: Translate English SRT cues into natural Korean.
STRICT output rules:
- Output ONLY the SRT content. No preamble, no code fences, no commentary, no closing remarks.
- Start immediately with the first cue index line (a bare integer).
- Preserve EVERY cue index line EXACTLY as in the input.
- Preserve EVERY timestamp line EXACTLY as in the input (the "HH:MM:SS,mmm --> HH:MM:SS,mmm" line).
- Translate only the text lines beneath each timestamp.
- Keep exactly the same number of cue blocks as the input — do NOT merge, split, drop, or add cues.
- Separate each cue block with a single blank line.
- Within a cue, keep ≤2 lines; you may rewrap Korean text as needed.
- Keep proper nouns, product names, code identifiers, file paths, and numbers in English.
- Use natural spoken Korean appropriate for a tech talk.`;

const runClaude = (prompt) => {
  const res = spawnSync(
    "claude",
    ["-p", "--model", "claude-sonnet-4-6", "--permission-mode", "bypassPermissions"],
    {
      input: prompt,
      encoding: "utf-8",
      maxBuffer: 20 * 1024 * 1024,
    }
  );
  if (res.status !== 0 || res.signal) {
    throw new Error(
      `claude exited status=${res.status} signal=${res.signal} stderr=${(res.stderr || "").slice(0, 200)}`
    );
  }
  return res.stdout;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Parse a loose SRT-ish text into cue blocks keyed by their leading index.
// Strips any leading preamble before the first valid "index + timestamp" pair.
const parseCues = (text) => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const cues = [];
  let i = 0;
  while (i < lines.length) {
    // find an index line (pure integer) followed on the next line by a timestamp
    if (/^\d+$/.test(lines[i].trim()) && i + 1 < lines.length && /-->/.test(lines[i + 1])) {
      const index = Number.parseInt(lines[i].trim(), 10);
      const ts = lines[i + 1].trim();
      const textLines = [];
      let j = i + 2;
      while (j < lines.length) {
        // stop at a blank line OR at the start of the next cue (index + timestamp)
        if (lines[j].trim() === "") break;
        if (
          /^\d+$/.test(lines[j].trim()) &&
          j + 1 < lines.length &&
          /-->/.test(lines[j + 1])
        ) {
          break;
        }
        textLines.push(lines[j]);
        j += 1;
      }
      cues.push({ index, ts, text: textLines.join("\n").trim() });
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return cues;
};

const translatedChunks = new Array(chunks.length).fill(null);
for (let i = 0; i < chunks.length; i += 1) {
  const expectedIndices = chunks[i].map((b) => {
    const m = b.match(/^(\d+)/);
    return m ? Number.parseInt(m[1], 10) : null;
  });
  const cached = progress.done[i];
  if (cached) {
    translatedChunks[i] = cached;
    continue;
  }
  const chunkText = chunks[i].join("\n\n");
  const prompt = `${SYSTEM}\n\nHere are ${chunks[i].length} SRT cues to translate. The first cue index is ${expectedIndices[0]} and the last is ${expectedIndices.at(-1)}. Output the same ${chunks[i].length} cues in Korean now:\n\n${chunkText}`;
  const t0 = Date.now();
  let result = null;
  let attempts = 0;
  while (attempts < 3) {
    attempts += 1;
    try {
      const raw = runClaude(prompt);
      const cues = parseCues(raw);
      if (cues.length !== chunks[i].length) {
        throw new Error(
          `cue count mismatch: got ${cues.length} want ${chunks[i].length}`
        );
      }
      // Verify indices match one-to-one in order.
      for (let k = 0; k < cues.length; k += 1) {
        if (cues[k].index !== expectedIndices[k]) {
          throw new Error(
            `index mismatch at pos ${k}: got ${cues[k].index} want ${expectedIndices[k]}`
          );
        }
      }
      result = cues
        .map((c) => `${c.index}\n${c.ts}\n${c.text}`)
        .join("\n\n");
      break;
    } catch (err) {
      console.warn(
        `chunk ${i + 1}/${chunks.length} attempt ${attempts} failed: ${err.message}`
      );
      if (attempts >= 3) throw err;
    }
  }
  translatedChunks[i] = result;
  progress.done[i] = result;
  writeFileSync(progressPath, JSON.stringify(progress), "utf-8");
  console.log(
    `chunk ${i + 1}/${chunks.length} ok in ${((Date.now() - t0) / 1000).toFixed(1)}s`
  );
  await sleep(1500);
}

const finalSrt = translatedChunks.join("\n\n") + "\n";
writeFileSync(outPath, finalSrt, "utf-8");
console.log(`✓ wrote ${outPath}`);
