#!/usr/bin/env node
// Remove a duplicated transcript pass from an SRT and renumber cues.
//
// The Daglo paginated-script API can return overlapping pages, which the older subtitle
// pipeline concatenated — producing the full transcript twice (the timeline restarts partway
// through the file). This script keeps cues up to the first point where the start time goes
// backwards (the restart), drops everything after, and renumbers from 1. It is lossless for
// the complete first pass and identical across language variants (timestamps match 1:1).
//
// usage: dedup-srt.mjs <file.srt> [outfile.srt]   (defaults to in-place)

import { readFileSync, writeFileSync } from "node:fs";

const [, , inputPath, outputArg] = process.argv;
if (!inputPath) {
  console.error("usage: dedup-srt.mjs <file.srt> [outfile.srt]");
  process.exit(1);
}
const outputPath = outputArg ?? inputPath;

const toSeconds = (ts) => {
  const m = ts.match(/(\d+):(\d+):(\d+),(\d+)\s*-->/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
};

const raw = readFileSync(inputPath, "utf-8").replace(/\r\n/g, "\n");
const blocks = raw.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);

const kept = [];
let prevStart = -Infinity;
let restartAt = -1;
for (let i = 0; i < blocks.length; i += 1) {
  const lines = blocks[i].split("\n");
  const start = toSeconds(lines[1] ?? "");
  if (start === null) {
    kept.push(blocks[i]);
    continue;
  }
  if (start < prevStart - 0.001) {
    restartAt = i;
    break; // timeline restarted -> the rest is a duplicate pass
  }
  prevStart = start;
  kept.push(blocks[i]);
}

// Renumber cues sequentially, preserving each cue's timestamp + text lines.
const renumbered = kept.map((block, index) => {
  const lines = block.split("\n");
  const body = /^\d+$/.test((lines[0] ?? "").trim()) ? lines.slice(1) : lines;
  return [`${index + 1}`, ...body].join("\n");
});

const result = renumbered.join("\n\n") + "\n";
writeFileSync(outputPath, result, "utf-8");
console.log(
  `${inputPath}: ${blocks.length} -> ${renumbered.length} cues` +
    (restartAt >= 0 ? ` (dropped duplicate pass starting at cue ${restartAt + 1})` : " (no duplicate found)")
);
