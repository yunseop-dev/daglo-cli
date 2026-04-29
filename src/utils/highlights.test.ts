import { describe, expect, it } from "vitest";
import {
  buildKeywords,
  buildShotTimes,
  pickHighlights,
  summarizeTranscript,
} from "./highlights.js";
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

const sampleSegments = (): NormalizedSubtitleSegment[] => [
  segment("Welcome everyone to this talk about Claude Code agents and tooling.", 0, 5),
  segment("Today we will discuss how context engineering changes daily workflow.", 5, 10),
  segment("Observability is critical when running long agents in production.", 10, 15),
  segment("The model can browse the web, run shell commands, and edit files.", 15, 20),
  segment("Engineers find that prompt caching saves both latency and cost.", 20, 25),
  segment("Hooks let teams enforce policy without modifying the agent core.", 25, 30),
  segment("In closing, treat your agent like a teammate, not a vending machine.", 30, 35),
];

describe("highlights", () => {
  it("buildKeywords promotes board-provided keywords and ranks by frequency", () => {
    const keywords = buildKeywords(sampleSegments(), {
      boardKeywords: ["agents", "context"],
      max: 5,
    });
    expect(keywords[0]).toBe("agents");
    expect(keywords[1]).toBe("context");
    expect(keywords).toContain("agent");
    expect(keywords.length).toBeLessThanOrEqual(5);
  });

  it("pickHighlights returns the requested number of unique segments", () => {
    const highlights = pickHighlights(sampleSegments(), 4, {
      preferredKeywords: ["agents", "observability"],
    });
    expect(highlights.length).toBeGreaterThanOrEqual(3);
    expect(highlights.length).toBeLessThanOrEqual(4);
    const keys = new Set(highlights.map((h) => `${h.startSec}:${h.endSec}`));
    expect(keys.size).toBe(highlights.length);
  });

  it("summarizeTranscript joins meaningful sentences and respects maxLength", () => {
    const summary = summarizeTranscript(sampleSegments(), { maxLength: 120 });
    expect(summary.length).toBeGreaterThan(0);
    expect(summary.length).toBeLessThanOrEqual(121);
  });

  it("buildShotTimes picks midpoints clamped within the duration", () => {
    const highlights = pickHighlights(sampleSegments(), 3);
    const times = buildShotTimes(35, highlights, 3);
    expect(times.length).toBe(3);
    for (const t of times) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(35);
    }
  });

  it("buildShotTimes returns empty when duration is zero", () => {
    expect(buildShotTimes(0, [], 4)).toEqual([]);
  });

  it("pickHighlights handles empty input", () => {
    expect(pickHighlights([], 4)).toEqual([]);
  });
});
