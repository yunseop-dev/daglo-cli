import type { NormalizedSubtitleSegment } from "./subtitles.js";

export type BriefAsset = {
  label: string;
  path: string;
  description?: string;
};

export type BriefScreenshot = {
  path: string;
  startSec: number;
  endSec: number;
};

export type BriefHighlight = {
  startSec: number;
  endSec: number;
  text: string;
};

export type BriefInput = {
  boardId: string;
  boardName: string;
  title: string;
  duration: number;
  youtubeUrl?: string | null;
  keywords: string[];
  summary: string;
  highlights: BriefHighlight[];
  screenshots: BriefScreenshot[];
  assets: BriefAsset[];
  segments: NormalizedSubtitleSegment[];
  outputDirName: string;
};

const formatMmss = (seconds: number): string => {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  return `${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
};

const sanitize = (value: string): string => value.replace(/\s+/g, " ").trim();

const truncate = (value: string, maxLength: number): string => {
  const cleaned = sanitize(value);
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength).trim()}…`;
};

const computeWordsPerMinute = (
  segments: NormalizedSubtitleSegment[],
  duration: number
): number => {
  if (duration <= 0) return 0;
  const totalWords = segments.reduce((sum, segment) => {
    return sum + (segment.text.match(/\S+/g)?.length ?? 0);
  }, 0);
  return Math.round((totalWords / duration) * 60);
};

const inferToneLabel = (wpm: number, durationSec: number): string => {
  const minutes = durationSec / 60;
  if (minutes >= 18 && wpm >= 130 && wpm <= 175) return "long-form keynote";
  if (minutes < 8) return "short talk / clip";
  if (wpm < 110) return "deliberate / interview-paced";
  if (wpm > 175) return "fast / casual / conversational";
  return "talk";
};

const pickNarrativeAnchors = (
  segments: NormalizedSubtitleSegment[]
): { intro: NormalizedSubtitleSegment[]; middle: NormalizedSubtitleSegment[]; outro: NormalizedSubtitleSegment[] } => {
  const meaty = segments.filter((segment) => sanitize(segment.text).length > 60);
  const source = meaty.length >= 6 ? meaty : segments;
  const total = source.length;
  if (total === 0) return { intro: [], middle: [], outro: [] };

  const introIndex = 0;
  const outroIndex = total - 1;
  const middleIndex = Math.floor(total / 2);

  const pickWindow = (center: number, count: number): NormalizedSubtitleSegment[] => {
    const start = Math.max(0, center);
    const result: NormalizedSubtitleSegment[] = [];
    for (let offset = 0; offset < count && start + offset < total; offset += 1) {
      result.push(source[start + offset]);
    }
    return result;
  };

  return {
    intro: pickWindow(introIndex, 2),
    middle: pickWindow(Math.max(0, middleIndex - 1), 2),
    outro: pickWindow(Math.max(0, outroIndex - 1), 2),
  };
};

const formatNarrativeParagraph = (segments: NormalizedSubtitleSegment[]): string => {
  if (segments.length === 0) return "_(no anchors found)_";
  return segments
    .map((segment) => `[${formatMmss(segment.startSec)}] ${truncate(segment.text, 240)}`)
    .join("  \n");
};

const buildSceneStructure = (duration: number, sceneCount: number): string[] => {
  const titleSec = Math.min(8, Math.max(4, duration * 0.02));
  const outroSec = Math.min(8, Math.max(4, duration * 0.02));
  const body = Math.max(duration - titleSec - outroSec, 0);
  const perScene = sceneCount > 0 ? body / sceneCount : body;

  const lines: string[] = [];
  lines.push(`- \`00:00 → ${formatMmss(titleSec)}\` **Title card** — open with the talk's name, speaker, and one keyword.`);
  for (let i = 0; i < sceneCount; i += 1) {
    const start = titleSec + i * perScene;
    const end = titleSec + (i + 1) * perScene;
    lines.push(
      `- \`${formatMmss(start)} → ${formatMmss(end)}\` **Scene ${i + 1}** — pair shot-${String(
        i + 1
      ).padStart(2, "0")}.jpg with highlight #${i + 1}; consider audio-reactive treatment.`
    );
  }
  lines.push(
    `- \`${formatMmss(duration - outroSec)} → ${formatMmss(duration)}\` **Outro** — closing quote from the last segment, fade audio, brand.`
  );
  return lines;
};

export const renderBriefMarkdown = (input: BriefInput): string => {
  const {
    boardId,
    boardName,
    title,
    duration,
    youtubeUrl,
    keywords,
    summary,
    highlights,
    screenshots,
    assets,
    segments,
    outputDirName,
  } = input;

  const wpm = computeWordsPerMinute(segments, duration);
  const tone = inferToneLabel(wpm, duration);
  const anchors = pickNarrativeAnchors(segments);

  const highlightLines = highlights.map((h, index) => {
    const range = `[${formatMmss(h.startSec)} → ${formatMmss(h.endSec)}]`;
    return `${index + 1}. ${range} \`${truncate(h.text, 220).replaceAll("`", "'")}\``;
  });

  const assetLines = assets.map((asset) => {
    const desc = asset.description ? ` — ${asset.description}` : "";
    return `- \`${asset.path}\` — **${asset.label}**${desc}`;
  });

  const screenshotLines = screenshots.map((shot, index) => {
    const tag = `shot-${String(index + 1).padStart(2, "0")}`;
    return `- \`${shot.path}\` (${tag}) — visible from \`${formatMmss(shot.startSec)}\` to \`${formatMmss(shot.endSec)}\``;
  });

  const sceneStructure = buildSceneStructure(duration, Math.min(highlights.length, 5));

  return `# HyperFrames Brief — ${title}

> Generated by daglo-cli. This brief feeds the **\`hyperframes\`** Claude Code skill.
> Read this together with \`DESIGN.md\` and \`assets/transcript.json\`, then build a
> bespoke composition in \`index.html\`. Do **not** treat this as a fixed template —
> the goal is a content-aware video, not a skin over data.

## 1. Source

- **Board**: \`${boardId}\` · ${boardName}
- **Composition title**: ${title}
- **Audio duration**: \`${formatMmss(duration)}\` (${duration.toFixed(1)}s)
- **YouTube**: ${youtubeUrl ? `<${youtubeUrl}>` : "_n/a_"}
- **Output directory**: \`${outputDirName}/\`

### Files in this directory

${assetLines.join("\n") || "_no assets recorded_"}

### Screenshots already extracted

${screenshotLines.join("\n") || "_no screenshots_"}

## 2. Narrative outline

**Opening** (~${formatMmss(anchors.intro[0]?.startSec ?? 0)})

${formatNarrativeParagraph(anchors.intro)}

**Middle** (~${formatMmss(anchors.middle[0]?.startSec ?? duration / 2)})

${formatNarrativeParagraph(anchors.middle)}

**Closing** (~${formatMmss(anchors.outro[0]?.startSec ?? duration)})

${formatNarrativeParagraph(anchors.outro)}

**One-line summary**: ${truncate(summary, 240) || "_no summary_"}

## 3. Suggested highlights (top ${highlights.length})

These are scored picks for visual emphasis — pull-quotes, lower thirds, scene anchors.
Quote text is verbatim from the transcript; trim or rephrase if needed.

${highlightLines.join("\n") || "_no highlights_"}

## 4. Tone signal

- **Topic keywords**: ${keywords.length ? keywords.map((k) => `\`${k}\``).join(", ") : "_n/a_"}
- **Words per minute**: ${wpm}
- **Inferred tone**: ${tone}
- **Visual mood hint**: pick a palette that supports the inferred tone — see \`DESIGN.md\`.

## 5. Suggested scene structure

This is a starting layout. Override it freely — the composition is yours to shape.

${sceneStructure.join("\n")}

## 6. Composition tasks for Claude Code

1. **Visual identity first**. Open \`DESIGN.md\` and either fill in the TBD fields or
   adopt one of the named presets from the hyperframes skill's \`visual-styles.md\`.
   No composition HTML before this is decided.
2. **Read the transcript**. \`assets/transcript.json\` has sentence-level segments
   with \`startSec\`/\`endSec\`. \`assets/captions.srt\` is ready for HyperFrames'
   \`transcribe\` if you want word-level captions.
3. **Build \`index.html\`** at the repo root of \`${outputDirName}/\`:
   - Standalone (no \`<template>\`); \`<div data-composition-id="${boardId.toLowerCase()}-story" data-width="1920" data-height="1080" data-start="0">\`
   - \`<audio>\` on track 0, source \`assets/audio.mp3\`
   - Caption overlay on track 1, swap text per cue (use the GSAP timeline)
   - Screenshots / b-roll on track 2 — they don't have to be all 4 stills, you can ignore some
   - Register \`window.__timelines["${boardId.toLowerCase()}-story"] = tl;\`
4. **Lint** before declaring done:
   \`\`\`
   npm exec --yes -- hyperframes lint ${outputDirName}
   \`\`\`
5. **Preview / render**:
   \`\`\`
   npm exec --yes -- hyperframes preview ${outputDirName}
   npm exec --yes -- hyperframes render ${outputDirName} --output ${outputDirName}/out.mp4
   \`\`\`

## 7. Anti-patterns

- A grid of all 4 screenshots crammed into one frame. The talk is ${formatMmss(duration)} — let the visuals breathe over time.
- Reading every line of the transcript on screen. Captions should be selective.
- Default \`#3b82f6\` blue, Roboto, generic dark gradient. Make the palette argue something.
`;
};

export const renderDesignScaffold = (input: BriefInput): string => {
  const { keywords, title } = input;
  const keywordHint = keywords.length
    ? keywords.slice(0, 6).join(", ")
    : "(no board keywords available)";

  return `# Visual Identity — ${title}

> **HARD GATE for the hyperframes skill.** Fill this in before writing any
> composition HTML. If a field is still TBD, pick a named preset from the
> hyperframes skill's \`visual-styles.md\` (Swiss Pulse, Liquid Lab, Gravity Index,
> etc.) and let it drive the rest.
>
> Topic keywords from the transcript: ${keywordHint}.

## Style Prompt

TBD — write one paragraph describing the mood, era, and reference points.
Example shape: "Late-night documentary cut with a Bloomberg-terminal accent.
Confident, dense, slightly confrontational. References: A24 doc title cards,
Stripe Press editorial, Linear's marketing site."

## Colors

| Role        | Hex     | Notes |
| ----------- | ------- | ----- |
| bg          | \`#?????\` | main canvas |
| surface     | \`#?????\` | cards, panels |
| fg          | \`#?????\` | primary text |
| accent      | \`#?????\` | emphasis, links |
| accent-warm | \`#?????\` | quoted highlights |

## Typography

- **Headlines**: TBD
- **Body**: TBD
- **Mono / metadata**: TBD

## Motion

- Default ease: TBD (e.g. \`power3.out\` for entrances, \`expo.in\` for exits)
- Caption swap style: TBD (cut, crossfade, marker-sweep, sketchout)
- Screenshot transition: TBD (crossfade, wipe, mask reveal)

## What NOT to Do

- Don't reach for the default web-blue palette; pick something that argues for the talk.
- Don't mix more than two display fonts.
- Don't render every caption; pick the moments that earn screen time.
- TBD — add a constraint that's specific to this talk.
`;
};
