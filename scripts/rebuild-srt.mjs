#!/usr/bin/env node
// Rebuild a readable SRT from a Daglo transcript JSON (the decoded `script`).
// Groups word-level karaoke tokens into phrases (~max duration, max chars, sentence
// boundaries), avoiding the over-aggressive CPS-based splitter.

import { readFileSync, writeFileSync } from "node:fs";

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error("usage: rebuild-srt.mjs <decoded-script.json> <out.srt>");
  process.exit(1);
}

const MAX_DUR = 6.0;         // seconds per cue
const MAX_CHARS = 84;        // two lines × 42
const MAX_LINE_CHARS = 42;
const MIN_DUR = 1.2;         // stretch very short cues up to this
const BREAK_GAP = 0.9;       // seconds of silence forces a new cue

const payload = JSON.parse(readFileSync(inputPath, "utf-8"));
const root = payload?.script?.editorState?.root ?? payload?.editorState?.root ?? payload?.root;
if (!root?.children) {
  console.error("could not locate editorState.root.children in input");
  process.exit(1);
}

// Flatten paragraphs → (speaker, karaoke tokens)
const tokens = [];
for (const paragraph of root.children) {
  let speaker = null;
  for (const child of paragraph.children ?? []) {
    if (child?.type === "speaker-block" && typeof child.speaker === "string") {
      speaker = child.speaker;
      continue;
    }
    if (
      child?.type === "karaoke" &&
      typeof child.text === "string" &&
      typeof child.s === "number" &&
      typeof child.e === "number"
    ) {
      tokens.push({ text: child.text, start: child.s, end: child.e, speaker, paragraphBreak: false });
    }
  }
  // mark the last token of each paragraph as a hard break candidate
  if (tokens.length > 0) tokens[tokens.length - 1].paragraphBreak = true;
}

const endsSentence = (text) => /[.!?](['")\]]*)\s*$/.test(text);

const normWs = (s) => s.replace(/\s+/g, " ").trim();

const cues = [];
let cur = null;
for (const tok of tokens) {
  const tokText = normWs(tok.text);
  if (!cur) {
    cur = { start: tok.start, end: tok.end, text: tokText, speaker: tok.speaker };
    continue;
  }
  const nextText = normWs(`${cur.text} ${tokText}`);
  const nextDur = tok.end - cur.start;
  const gap = tok.start - cur.end;
  const shouldBreak =
    gap > BREAK_GAP ||
    nextDur > MAX_DUR ||
    nextText.length > MAX_CHARS ||
    endsSentence(cur.text) ||
    tok.speaker !== cur.speaker ||
    cur._paragraphBreak;

  if (shouldBreak) {
    cues.push(cur);
    cur = { start: tok.start, end: tok.end, text: tokText, speaker: tok.speaker };
  } else {
    cur.end = tok.end;
    cur.text = nextText;
  }
  if (tok.paragraphBreak) cur._paragraphBreak = true;
}
if (cur) cues.push(cur);

// Enforce min-duration by borrowing from the gap before the next cue.
for (let i = 0; i < cues.length; i += 1) {
  const c = cues[i];
  const next = cues[i + 1];
  if (c.end - c.start < MIN_DUR) {
    const cap = next ? next.start : c.end + MIN_DUR;
    c.end = Math.min(c.start + MIN_DUR, cap);
  }
}

const wrap = (text) => {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    if (!line) {
      line = w;
      continue;
    }
    if (line.length + 1 + w.length <= MAX_LINE_CHARS) {
      line = `${line} ${w}`;
    } else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  // Cap to 2 lines; if longer text snuck through, concatenate remainder.
  if (lines.length > 2) {
    const first = lines[0];
    const rest = lines.slice(1).join(" ");
    return [first, rest];
  }
  return lines;
};

const fmt = (sec) => {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const mil = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(mil).padStart(3, "0")}`;
};

const out = [];
cues.forEach((c, i) => {
  const lines = wrap(c.text);
  out.push(String(i + 1));
  out.push(`${fmt(c.start)} --> ${fmt(c.end)}`);
  out.push(...lines);
  out.push("");
});

writeFileSync(outputPath, out.join("\n"), "utf-8");
console.log(`✓ wrote ${outputPath} — ${cues.length} cues`);
