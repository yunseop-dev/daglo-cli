import { describe, expect, it } from "vitest";
import {
  renderBriefMarkdown,
  renderDesignScaffold,
  type BriefInput,
} from "./hyperframes-brief.js";
import type { NormalizedSubtitleSegment } from "./subtitles.js";

const segment = (
  text: string,
  startSec: number,
  endSec: number
): NormalizedSubtitleSegment => ({
  text,
  startSec,
  endSec,
  speakerKey: null,
  speakerLabel: null,
  raw: { text, startSec, endSec },
});

const buildInput = (overrides: Partial<BriefInput> = {}): BriefInput => ({
  boardId: "ABC123",
  boardName: "Test board",
  title: "Test board",
  duration: 1309,
  youtubeUrl: "https://youtube.com/watch?v=xyz",
  keywords: ["claude", "agents", "context", "tooling"],
  summary: "A talk about Claude Code agents in the engineering workflow.",
  highlights: Array.from({ length: 8 }, (_, index) => ({
    startSec: index * 120,
    endSec: index * 120 + 8,
    text: `Highlight ${index + 1} text that the speaker said with conviction.`,
  })),
  screenshots: [
    { path: "assets/screenshots/shot-01.jpg", startSec: 60, endSec: 320 },
    { path: "assets/screenshots/shot-02.jpg", startSec: 320, endSec: 640 },
    { path: "assets/screenshots/shot-03.jpg", startSec: 640, endSec: 960 },
    { path: "assets/screenshots/shot-04.jpg", startSec: 960, endSec: 1309 },
  ],
  assets: [
    { label: "audio", path: "assets/audio.mp3", description: "full talk audio" },
    { label: "captions", path: "assets/captions.srt" },
    { label: "transcript", path: "assets/transcript.json", description: "sentence-level" },
  ],
  segments: Array.from({ length: 50 }, (_, index) =>
    segment(
      `Sentence ${index + 1} with several meaningful words about agents and tooling.`,
      index * 25,
      index * 25 + 24
    )
  ),
  outputDirName: "hyperframes/test-board",
  ...overrides,
});

describe("renderBriefMarkdown", () => {
  it("includes all required sections", () => {
    const md = renderBriefMarkdown(buildInput());
    expect(md).toContain("## 1. Source");
    expect(md).toContain("## 2. Narrative outline");
    expect(md).toContain("## 3. Suggested highlights");
    expect(md).toContain("## 4. Tone signal");
    expect(md).toContain("## 5. Suggested scene structure");
    expect(md).toContain("## 6. Composition tasks for Claude Code");
  });

  it("renders all 8 highlights with mm:ss timestamps", () => {
    const md = renderBriefMarkdown(buildInput());
    for (let i = 0; i < 8; i += 1) {
      expect(md).toContain(`${i + 1}.`);
    }
    expect(md).toMatch(/\[\d{2}:\d{2} → \d{2}:\d{2}\]/);
  });

  it("lists assets and screenshots with their paths", () => {
    const md = renderBriefMarkdown(buildInput());
    expect(md).toContain("`assets/audio.mp3`");
    expect(md).toContain("`assets/captions.srt`");
    expect(md).toContain("`assets/screenshots/shot-01.jpg`");
  });

  it("renders YouTube link when provided and skips when missing", () => {
    const withYt = renderBriefMarkdown(buildInput());
    expect(withYt).toContain("<https://youtube.com/watch?v=xyz>");
    const withoutYt = renderBriefMarkdown(buildInput({ youtubeUrl: null }));
    expect(withoutYt).toContain("**YouTube**: _n/a_");
  });

  it("derives words-per-minute and a tone label", () => {
    const md = renderBriefMarkdown(buildInput());
    expect(md).toMatch(/\*\*Words per minute\*\*: \d+/);
    expect(md).toMatch(/\*\*Inferred tone\*\*: [a-z /]+/);
  });

  it("escapes backticks in highlight quotes", () => {
    const md = renderBriefMarkdown(
      buildInput({
        highlights: [
          {
            startSec: 0,
            endSec: 5,
            text: "Use `npm exec` to run commands",
          },
        ],
      })
    );
    expect(md).not.toContain("`Use `npm exec`");
    expect(md).toContain("'npm exec'");
  });
});

describe("renderDesignScaffold", () => {
  it("contains the HARD-GATE headers required by the hyperframes skill", () => {
    const md = renderDesignScaffold(buildInput());
    expect(md).toContain("## Style Prompt");
    expect(md).toContain("## Colors");
    expect(md).toContain("## Typography");
    expect(md).toContain("## What NOT to Do");
  });

  it("surfaces keyword hints to guide tone selection", () => {
    const md = renderDesignScaffold(buildInput());
    expect(md).toContain("claude");
    expect(md).toContain("agents");
  });

  it("uses TBD placeholders rather than concrete defaults", () => {
    const md = renderDesignScaffold(buildInput());
    expect(md).toContain("TBD");
    expect(md).not.toMatch(/#3b82f6/i);
  });
});
