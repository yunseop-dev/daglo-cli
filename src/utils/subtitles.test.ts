import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeSubtitleSegments, segmentSubtitleCues, serializeSubtitleCues } from "./subtitles.js";

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../.sisyphus/evidence/task-5-srt-fixture.srt"
);

const createTask5SrtFixture = () => {
  const cues = [
    {
      startSec: 0.5,
      endSec: 0.75,
      speakerKey: null,
      speakerLabel: null,
      lines: ["삭제될 cue"],
      text: "삭제될 cue",
      segments: [],
    },
    {
      startSec: 1,
      endSec: 2.5,
      speakerKey: null,
      speakerLabel: null,
      lines: ["첫 줄", "둘째 줄"],
      text: "첫 줄\n둘째 줄",
      segments: [],
    },
    {
      startSec: 2.75,
      endSec: 4,
      speakerKey: null,
      speakerLabel: null,
      lines: ["UTF-8 한글 ✓"],
      text: "UTF-8 한글 ✓",
      segments: [],
    },
  ];

  return serializeSubtitleCues(cues, 1);
};

const syncTask5SrtFixture = (): string => {
  const expectedSrt = createTask5SrtFixture();
  mkdirSync(dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, expectedSrt, "utf-8");
  return expectedSrt;
};

describe("normalizeSubtitleSegments", () => {
  it("scales millisecond timestamps into seconds for transcript arrays", () => {
    const segments = normalizeSubtitleSegments(
      [
        { text: "첫 문장", startMs: 1000, endMs: 2500 },
        { text: "둘째 문장", startMs: 2500, endMs: 5000 },
      ],
      { videoDuration: 30 }
    );

    expect(segments).toEqual([
      {
        text: "첫 문장",
        startSec: 1,
        endSec: 2.5,
        speakerKey: null,
        speakerLabel: null,
        raw: { text: "첫 문장", startMs: 1000, endMs: 2500 },
      },
      {
        text: "둘째 문장",
        startSec: 2.5,
        endSec: 5,
        speakerKey: null,
        speakerLabel: null,
        raw: { text: "둘째 문장", startMs: 2500, endMs: 5000 },
      },
    ]);
  });

  it("honors mixed speaker keys and maps opaque speakers in encounter order", () => {
    const segments = normalizeSubtitleSegments([
      { text: "안녕하세요", startTime: 0, endTime: 1, speakerName: "Alice" },
      { text: "반갑습니다", startTime: 1, endTime: 2, speakerId: "spk_91" },
      { text: "다시 Alice", startTime: 2, endTime: 3, speaker: "Alice" },
      { text: "두 번째 화자", startTime: 3, endTime: 4, speakerNumber: 2 },
      { text: "표시 라벨", startTime: 4, endTime: 5, speakerLabel: "Bob" },
    ]);

    expect(segments.map((segment) => ({
      speakerKey: segment.speakerKey,
      speakerLabel: segment.speakerLabel,
    }))).toEqual([
      { speakerKey: "Alice", speakerLabel: "Alice" },
      { speakerKey: "spk_91", speakerLabel: "Speaker 1" },
      { speakerKey: "Alice", speakerLabel: "Alice" },
      { speakerKey: "2", speakerLabel: "Speaker 2" },
      { speakerKey: "Bob", speakerLabel: "Bob" },
    ]);
  });

  it("normalizes editorState karaoke tokens and clamps negative starts", () => {
    const script = {
      editorState: {
        root: {
          children: [
            {
              children: [
                { type: "karaoke", text: "첫 토큰", s: -0.25, e: 0.5, speakerId: "spk-a" },
                { type: "karaoke", text: "둘째 토큰", s: 0.5, e: 1.1, speakerId: "spk-a" },
              ],
            },
          ],
        },
      },
    };

    const segments = normalizeSubtitleSegments(script);

    expect(segments).toEqual([
      {
        text: "첫 토큰",
        startSec: 0,
        endSec: 0.5,
        speakerKey: "spk-a",
        speakerLabel: "Speaker 1",
        raw: { type: "karaoke", text: "첫 토큰", s: -0.25, e: 0.5, speakerId: "spk-a" },
      },
      {
        text: "둘째 토큰",
        startSec: 0.5,
        endSec: 1.1,
        speakerKey: "spk-a",
        speakerLabel: "Speaker 1",
        raw: { type: "karaoke", text: "둘째 토큰", s: 0.5, e: 1.1, speakerId: "spk-a" },
      },
    ]);
  });

  it("returns normalized segments sorted by startSec ascending", () => {
    const segments = normalizeSubtitleSegments([
      { text: "세 번째", startTime: 4, endTime: 5 },
      { text: "첫 번째", startTime: 0, endTime: 1 },
      { text: "두 번째", startTime: 2, endTime: 3 },
    ]);

    expect(segments.map(({ text, startSec, endSec }) => ({ text, startSec, endSec }))).toEqual([
      { text: "첫 번째", startSec: 0, endSec: 1 },
      { text: "두 번째", startSec: 2, endSec: 3 },
      { text: "세 번째", startSec: 4, endSec: 5 },
    ]);
  });

  it("drops empty text segments when the invalid ratio stays within ten percent", () => {
    const input = Array.from({ length: 10 }, (_, index) => ({
      text: index === 4 ? "   " : `segment-${index + 1}`,
      startTime: index,
      endTime: index + 0.5,
    }));

    const segments = normalizeSubtitleSegments(input);

    expect(segments).toHaveLength(9);
    expect(segments.every((segment) => segment.text.length > 0)).toBe(true);
  });

  it("drops invalid ranges when the invalid ratio stays within ten percent", () => {
    const input = Array.from({ length: 10 }, (_, index) => ({
      text: `segment-${index + 1}`,
      startTime: index,
      endTime: index === 2 ? index : index + 0.5,
    }));

    const segments = normalizeSubtitleSegments(input);

    expect(segments).toHaveLength(9);
    expect(segments.some((segment) => segment.text === "segment-3")).toBe(false);
  });

  it("hard fails when the invalid drop ratio exceeds ten percent", () => {
    expect(() =>
      normalizeSubtitleSegments([
        { text: "정상", startTime: 0, endTime: 1 },
        { text: "", startTime: 1, endTime: 2 },
        { text: "역전", startTime: 4, endTime: 3 },
      ])
    ).toThrow("Subtitle normalization dropped too many segments (2/3).");
  });

  it("hard fails when no usable segment remains", () => {
    expect(() =>
      normalizeSubtitleSegments([
        { text: "   ", startTime: 0, endTime: 1 },
        { text: "역전", startTime: 3, endTime: 2 },
      ])
    ).toThrow("No usable subtitle segments after normalization.");
  });

  it("hard fails when karaoke-only input has no usable transcript segments", () => {
    expect(() =>
      normalizeSubtitleSegments({
        editorState: {
          root: {
            children: [
              {
                children: [
                  { type: "karaoke", text: "   ", s: 0, e: 0.5 },
                  { type: "karaoke", text: "역전 구간", s: 2, e: 1.5 },
                ],
              },
            ],
          },
        },
      })
    ).toThrow("No usable subtitle segments after normalization.");
  });
});

describe("segmentSubtitleCues", () => {
  const getVisibleCharCount = (text: string) => text.replace(/\n/g, "").length;

  const expectCueLimits = (cue: { startSec: number; endSec: number; lines: string[]; text: string }) => {
    const duration = cue.endSec - cue.startSec;
    const cps = getVisibleCharCount(cue.text) / duration;

    expect(cue.lines.length).toBeLessThanOrEqual(2);
    expect(getVisibleCharCount(cue.text)).toBeLessThanOrEqual(84);
    expect(duration).toBeGreaterThanOrEqual(1);
    expect(duration).toBeLessThanOrEqual(7);
    expect(cps).toBeLessThanOrEqual(20);
  };

  it("prefers sentence punctuation boundaries for long utterances", () => {
    const segments = normalizeSubtitleSegments([
      {
        text: "첫 문장입니다. 둘째 문장도 충분히 길어서 분리 대상입니다! 셋째 문장도 이어집니다? 넷째 문장으로 마무리합니다.",
        startTime: 0,
        endTime: 12,
      },
    ]);

    const cues = segmentSubtitleCues(segments);

    expect(cues.length).toBeGreaterThan(1);
    expect(cues.slice(0, -1).every((cue) => /[.?!。！？]$/.test(cue.text.replace(/\n/g, "")))).toBe(true);
    cues.forEach(expectCueLimits);
  });

  it("falls back to readability boundaries when punctuation is missing", () => {
    const segments = normalizeSubtitleSegments([
      {
        text: "이 기능은 화면에서 바로 확인할 수 있도록 충분히 자세한 설명을 먼저 보여 주고 그리고 사용자가 다음 단계로 자연스럽게 넘어가도록 안내 문구를 유지해야 합니다",
        startTime: 0,
        endTime: 8,
      },
    ]);

    const cues = segmentSubtitleCues(segments);

    expect(cues.length).toBeGreaterThan(1);
    expect(cues.map((cue) => cue.text.replace(/\n/g, " ").replace(/\s+/g, " ").trim()).join(" ")).toContain(
      "충분히 자세한 설명을 먼저 보여 주고 그리고 사용자가 다음 단계로 자연스럽게 넘어가도록 안내 문구를 유지해야 합니다"
    );
    cues.forEach(expectCueLimits);
  });

  it("never merges across speaker boundaries, including unknown versus named speakers", () => {
    const segments = normalizeSubtitleSegments([
      { text: "안녕하세요 반갑습니다", startTime: 0, endTime: 1.2, speakerName: "Alice" },
      { text: "이 구간은 화자 정보가 없습니다", startTime: 1.2, endTime: 2.7 },
      { text: "다시 앨리스입니다", startTime: 2.7, endTime: 4.1, speakerName: "Alice" },
      { text: "이번에는 밥입니다", startTime: 4.1, endTime: 5.6, speakerLabel: "Bob" },
    ]);

    const cues = segmentSubtitleCues(segments);

    expect(cues).toHaveLength(4);
    expect(cues.map((cue) => cue.speakerLabel)).toEqual(["Alice", null, "Alice", "Bob"]);
    expect(cues.every((cue) => new Set(cue.segments.map((segment) => segment.speakerKey)).size <= 1)).toBe(true);
    expect(cues[0]?.text.startsWith(">> Alice: ")).toBe(true);
    expect(cues[1]?.text.startsWith(">> ")).toBe(false);
    expect(cues[3]?.text.startsWith(">> Bob: ")).toBe(true);
    cues.forEach(expectCueLimits);
  });

  it("keeps cues within line, character, duration, and cps limits", () => {
    const segments = normalizeSubtitleSegments([
      {
        text: "하나의 자막 큐가 지나치게 길어지지 않도록 읽기 좋은 경계에서 잘라야 하고 쉼표가 있으면 먼저 활용해야 하며 전체 길이와 속도 제한도 함께 지켜야 합니다, 그래서 여기에서 한 번 더 나눕니다",
        startTime: 0,
        endTime: 10,
        speakerName: "Narrator",
      },
    ]);

    const cues = segmentSubtitleCues(segments);

    expect(cues.length).toBeGreaterThan(1);
    expect(cues.every((cue) => cue.text.startsWith(">> Narrator: "))).toBe(true);
    cues.forEach(expectCueLimits);
  });

  it("keeps an exact 84-character cue within the hard limit boundary", () => {
    const exactBoundaryText = "가".repeat(84);
    const segments = normalizeSubtitleSegments([
      {
        text: exactBoundaryText,
        startTime: 0,
        endTime: 4.2,
      },
    ]);

    const cues = segmentSubtitleCues(segments);

    expect(cues).toHaveLength(1);
    expect(cues[0]?.text.replace(/\n/g, "").length).toBe(84);
    expect(cues[0]?.lines).toHaveLength(2);
    cues.forEach(expectCueLimits);
  });

  it("splits cues once the readable boundary exceeds 84 visible characters", () => {
    const overBoundaryText = "가".repeat(85);
    const segments = normalizeSubtitleSegments([
      {
        text: overBoundaryText,
        startTime: 0,
        endTime: 5,
      },
    ]);

    const cues = segmentSubtitleCues(segments);

    expect(cues.length).toBeGreaterThan(1);
    expect(cues.map((cue) => cue.text.replace(/\n/g, "")).join("")).toBe(overBoundaryText);
    cues.forEach(expectCueLimits);
  });
});

describe("serializeSubtitleCues", () => {
  it("keeps numbering continuous, preserves line breaks, and applies clip offsets", () => {
    const srt = createTask5SrtFixture();

    expect(srt).toBe(
      [
        "1",
        "00:00:00,000 --> 00:00:01,500",
        "첫 줄",
        "둘째 줄",
        "",
        "2",
        "00:00:01,750 --> 00:00:03,000",
        "UTF-8 한글 ✓",
        "",
        "",
      ].join("\n")
    );
  });

  it("supports full mode with a zero clip offset", () => {
    const srt = serializeSubtitleCues(
      [
        {
          startSec: 10,
          endSec: 12.25,
          speakerKey: null,
          speakerLabel: null,
          lines: ["Full mode"],
          text: "Full mode",
          segments: [],
        },
      ]
    );

    expect(srt).toBe(["1", "00:00:10,000 --> 00:00:12,250", "Full mode", "", ""].join("\n"));
  });

  it("writes and round-trips the UTF-8 evidence fixture", () => {
    const expectedSrt = syncTask5SrtFixture();

    expect(readFileSync(fixturePath, "utf-8")).toBe(expectedSrt);
  });

  it("skips non-positive cues after clip offsets while keeping numbering dense", () => {
    const srt = serializeSubtitleCues(
      [
        {
          startSec: 0,
          endSec: 1,
          speakerKey: null,
          speakerLabel: null,
          lines: ["사라질 cue"],
          text: "사라질 cue",
          segments: [],
        },
        {
          startSec: 1.25,
          endSec: 2.5,
          speakerKey: null,
          speakerLabel: null,
          lines: ["남는 cue"],
          text: "남는 cue",
          segments: [],
        },
      ],
      1
    );

    expect(srt).toBe(["1", "00:00:00,250 --> 00:00:01,500", "남는 cue", "", ""].join("\n"));
  });
});
