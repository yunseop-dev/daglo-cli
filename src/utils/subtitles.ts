const START_TIME_KEYS = ["startTime", "start", "startMs", "start_time", "s"] as const;
const END_TIME_KEYS = ["endTime", "end", "endMs", "end_time", "e"] as const;
const SPEAKER_KEYS = [
  "speakerName",
  "speaker",
  "speakerLabel",
  "speakerId",
  "speaker_id",
  "speakerNumber",
  "speakerNo",
  "speakerTag",
  "talker",
  "spk",
] as const;

const HUMAN_SPEAKER_KEYS = new Set<string>(["speakerName", "speaker", "speakerLabel"]);

type TimedRecord = Record<string, unknown>;

export type NormalizedSubtitleSegment = {
  text: string;
  startSec: number;
  endSec: number;
  speakerKey: string | null;
  speakerLabel: string | null;
  raw: unknown;
};

export type NormalizeSubtitleSegmentsOptions = {
  videoDuration?: number;
};

export type SubtitleCue = {
  startSec: number;
  endSec: number;
  speakerKey: string | null;
  speakerLabel: string | null;
  lines: string[];
  text: string;
  segments: NormalizedSubtitleSegment[];
};

type ExtractedSpeaker = {
  key: string;
  label: string | null;
};

type CueFragment = {
  text: string;
  startSec: number;
  endSec: number;
  speakerKey: string | null;
  speakerLabel: string | null;
  segments: NormalizedSubtitleSegment[];
};

const MAX_CUE_LINES = 2;
const MAX_CUE_CHARS = 84;
const MAX_LINE_CHARS = 42;
const MIN_CUE_DURATION_SEC = 1;
const MAX_CUE_DURATION_SEC = 7;
const TARGET_CPS = 16;
const SOFT_MAX_CPS = 17;
const HARD_MAX_CPS = 20;
const DEFAULT_MAX_LINE_CHARS = 42;
// Once a cue's left side ends a sentence and is at least this long, prefer to end the cue
// there rather than packing the next sentence in. Keeps fast, word-level transcripts aligned
// to sentence boundaries instead of arbitrary 84-character blocks.
const SENTENCE_BREAK_MIN_CHARS = 20;
const SENTENCE_PUNCTUATION_REGEX = /[.?!。！？]/;
const SENTENCE_END_REGEX = /[.?!。！？]\s*$/;
const SECONDARY_CONJUNCTION_REGEX =
  /(?:^|\s)(and|but|or|so|because|while|although|though|if|when|then|therefore|however|그리고|하지만|그래서|또는|근데|다만)(?=\s)/gi;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
};

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

const extractFirstNumber = (item: TimedRecord, keys: readonly string[]): number | null => {
  for (const key of keys) {
    const value = toFiniteNumber(item[key]);
    if (value !== null) return value;
  }

  return null;
};

const extractText = (value: unknown): string => {
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }

  if (!isRecord(value)) return "";

  if (typeof value.text === "string") {
    return value.text.replace(/\s+/g, " ").trim();
  }

  if (typeof value.content === "string") {
    return value.content.replace(/\s+/g, " ").trim();
  }

  if (Array.isArray(value.tokens)) {
    const text = value.tokens
      .map((token) => {
        if (!isRecord(token)) return "";
        if (typeof token.text === "string") return token.text;
        if (typeof token.word === "string") return token.word;
        return "";
      })
      .join("")
      .replace(/\s+/g, " ")
      .trim();

    return text;
  }

  return "";
};

const extractSpeaker = (
  item: TimedRecord,
  speakerLabelMap: Map<string, string>
): ExtractedSpeaker | null => {
  for (const key of SPEAKER_KEYS) {
    const value = item[key];
    if (value === undefined || value === null) continue;

    const normalized = String(value).trim();
    if (!normalized) continue;

    if (HUMAN_SPEAKER_KEYS.has(key)) {
      return { key: normalized, label: normalized };
    }

    let label = speakerLabelMap.get(normalized);
    if (!label) {
      label = `Speaker ${speakerLabelMap.size + 1}`;
      speakerLabelMap.set(normalized, label);
    }

    return { key: normalized, label };
  }

  return null;
};

const collectKaraokeNodes = (value: unknown, nodes: TimedRecord[]) => {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectKaraokeNodes(entry, nodes));
    return;
  }

  if (!isRecord(value)) return;

  if (
    value.type === "karaoke" &&
    typeof value.text === "string" &&
    extractFirstNumber(value, START_TIME_KEYS) !== null &&
    extractFirstNumber(value, END_TIME_KEYS) !== null
  ) {
    nodes.push(value);
  }

  for (const nestedValue of Object.values(value)) {
    collectKaraokeNodes(nestedValue, nodes);
  }
};

const parseJsonString = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

const extractSourceItems = (input: unknown): TimedRecord[] => {
  if (typeof input === "string") {
    return extractSourceItems(parseJsonString(input));
  }

  if (Array.isArray(input)) {
    return input.filter(isRecord);
  }

  if (!isRecord(input)) {
    return [];
  }

  if (Array.isArray(input.items)) {
    return input.items.filter(isRecord);
  }

  if (Array.isArray(input.data)) {
    return input.data.filter(isRecord);
  }

  if (isRecord(input.script)) {
    return extractSourceItems(input.script);
  }

  if (isRecord(input.editorState) || input.type === "karaoke") {
    const nodes: TimedRecord[] = [];
    collectKaraokeNodes(input.editorState ?? input, nodes);
    if (nodes.length > 0) return nodes;
  }

  if (typeof input.item === "string") {
    return extractSourceItems(input.item);
  }

  if (typeof input.content === "string") {
    return extractSourceItems(input.content);
  }

  if (typeof input.text === "string") {
    return extractSourceItems(input.text);
  }

  return [];
};

const shouldScaleMsToSec = (segments: Array<{ startSec: number; endSec: number }>, videoDuration?: number) => {
  if (segments.length === 0) return false;

  const threshold =
    typeof videoDuration === "number" && Number.isFinite(videoDuration) && videoDuration > 0
      ? Math.min(videoDuration * 10, 10000)
      : 10000;

  return segments.some((segment) => segment.startSec > threshold || segment.endSec > threshold);
};

export const normalizeSubtitleSegments = (
  input: unknown,
  options: NormalizeSubtitleSegmentsOptions = {}
): NormalizedSubtitleSegment[] => {
  const sourceItems = extractSourceItems(input);
  const speakerLabelMap = new Map<string, string>();
  const draftSegments: NormalizedSubtitleSegment[] = [];

  for (const item of sourceItems) {
    const text = extractText(item);
    const startValue = extractFirstNumber(item, START_TIME_KEYS);
    const endValue = extractFirstNumber(item, END_TIME_KEYS);
    const speaker = extractSpeaker(item, speakerLabelMap);

    draftSegments.push({
      text,
      startSec: startValue ?? Number.NaN,
      endSec: endValue ?? Number.NaN,
      speakerKey: speaker?.key ?? null,
      speakerLabel: speaker?.label ?? null,
      raw: item,
    });
  }

  const scaledSegments = shouldScaleMsToSec(draftSegments, options.videoDuration)
    ? draftSegments.map((segment) => ({
        ...segment,
        startSec: segment.startSec / 1000,
        endSec: segment.endSec / 1000,
      }))
    : draftSegments;

  const usableSegments = scaledSegments.filter((segment) => {
    if (!segment.text) return false;
    if (!Number.isFinite(segment.startSec) || !Number.isFinite(segment.endSec)) return false;

    const clampedStart = Math.max(segment.startSec, 0);
    if (segment.endSec <= clampedStart) return false;

    segment.startSec = clampedStart;
    return true;
  });

  const droppedCount = scaledSegments.length - usableSegments.length;
  const dropRatio = scaledSegments.length > 0 ? droppedCount / scaledSegments.length : 1;

  if (usableSegments.length < 1) {
    throw new Error("No usable subtitle segments after normalization.");
  }

  if (dropRatio > 0.1) {
    throw new Error(
      `Subtitle normalization dropped too many segments (${droppedCount}/${scaledSegments.length}).`
    );
  }

  return usableSegments.sort((left, right) => {
    if (left.startSec !== right.startSec) return left.startSec - right.startSec;
    if (left.endSec !== right.endSec) return left.endSec - right.endSec;
    return left.text.localeCompare(right.text);
  });
};

const normalizeCueWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

const buildSpeakerPrefix = (speakerLabel: string | null): string => {
  return speakerLabel ? `>> ${speakerLabel}: ` : "";
};

const splitLongWord = (word: string, maxLength: number): string[] => {
  if (word.length <= maxLength) return [word];

  const parts: string[] = [];
  let remaining = word;

  while (remaining.length > maxLength) {
    parts.push(remaining.slice(0, maxLength));
    remaining = remaining.slice(maxLength);
  }

  if (remaining.length > 0) {
    parts.push(remaining);
  }

  return parts;
};

const wrapCueText = (speakerLabel: string | null, text: string, maxLineChars = DEFAULT_MAX_LINE_CHARS): string[] => {
  const displayText = `${buildSpeakerPrefix(speakerLabel)}${normalizeCueWhitespace(text)}`.trim();
  if (!displayText) return [];

  if (!/\s/.test(displayText)) {
    return splitLongWord(displayText, maxLineChars);
  }

  const words = displayText.split(" ");
  const lines: string[] = [];
  let currentLine = "";

  const flushLine = () => {
    if (currentLine) {
      lines.push(currentLine);
      currentLine = "";
    }
  };

  for (const word of words) {
    if (!currentLine) {
      if (word.length > maxLineChars) {
        lines.push(...splitLongWord(word, maxLineChars));
        continue;
      }

      currentLine = word;
      continue;
    }

    if (currentLine.length + 1 + word.length <= maxLineChars) {
      currentLine = `${currentLine} ${word}`;
      continue;
    }

    flushLine();
    if (word.length > maxLineChars) {
      lines.push(...splitLongWord(word, maxLineChars));
      continue;
    }

    currentLine = word;
  }

  flushLine();
  return lines;
};

const getCueCharCount = (speakerLabel: string | null, text: string): number => {
  return buildSpeakerPrefix(speakerLabel).length + normalizeCueWhitespace(text).length;
};

const getCueDuration = (fragment: Pick<CueFragment, "startSec" | "endSec">): number => {
  return Math.max(fragment.endSec - fragment.startSec, 0.001);
};

const getCueCps = (speakerLabel: string | null, text: string, duration: number): number => {
  return getCueCharCount(speakerLabel, text) / Math.max(duration, 0.001);
};

const isSameSpeaker = (
  left: Pick<CueFragment, "speakerKey" | "speakerLabel">,
  right: Pick<CueFragment, "speakerKey" | "speakerLabel">
): boolean => {
  return left.speakerKey === right.speakerKey && left.speakerLabel === right.speakerLabel;
};

const endsWithSentencePunctuation = (text: string): boolean => {
  return SENTENCE_END_REGEX.test(normalizeCueWhitespace(text));
};

// Structural limits only — character count, line count, and duration. Reading speed (cps) is
// deliberately excluded: splitting a too-fast cue cannot lower its cps (each piece keeps a
// proportional slice of the duration), so treating cps as a hard limit here would recurse a
// short word down to single characters. cps is handled as a preference during merging instead.
const isCueWithinStructuralLimits = (
  fragment: CueFragment,
  maxLineChars = DEFAULT_MAX_LINE_CHARS
): boolean => {
  if (getCueDuration(fragment) > MAX_CUE_DURATION_SEC) return false;
  if (getCueCharCount(fragment.speakerLabel, fragment.text) > MAX_CUE_CHARS) return false;
  if (wrapCueText(fragment.speakerLabel, fragment.text, maxLineChars).length > MAX_CUE_LINES) return false;
  return true;
};

const getSentenceBoundaryPositions = (text: string): number[] => {
  const positions: number[] = [];

  for (let index = 0; index < text.length; index += 1) {
    if (!SENTENCE_PUNCTUATION_REGEX.test(text[index] ?? "")) continue;

    let boundary = index + 1;
    while (boundary < text.length && /\s/.test(text[boundary] ?? "")) {
      boundary += 1;
    }

    if (boundary > 0 && boundary < text.length) {
      positions.push(boundary);
    }
  }

  return positions;
};

const getSecondaryBoundaryPositions = (text: string): number[] => {
  const positions = new Set<number>();

  for (const match of text.matchAll(/[,;:，、]\s*/g)) {
    const boundary = match.index + match[0].length;
    if (boundary > 0 && boundary < text.length) {
      positions.add(boundary);
    }
  }

  for (const match of text.matchAll(SECONDARY_CONJUNCTION_REGEX)) {
    const boundary = (match.index ?? 0) + (match[0].startsWith(" ") ? 1 : 0);
    if (boundary > 0 && boundary < text.length) {
      positions.add(boundary);
    }
  }

  for (const match of text.matchAll(/\s+/g)) {
    const boundary = match.index;
    if (boundary > 0 && boundary < text.length) {
      positions.add(boundary);
    }
  }

  return Array.from(positions).sort((left, right) => left - right);
};

const chooseBoundaryPosition = (text: string, positions: number[], target: number): number | null => {
  const minPieceChars = Math.min(12, Math.max(4, Math.floor(text.length * 0.2)));
  const filtered = positions.filter(
    (position) => position >= minPieceChars && text.length - position >= minPieceChars
  );

  if (filtered.length === 0) return null;

  return filtered.reduce((best, current) => {
    const bestDelta = Math.abs(best - target);
    const currentDelta = Math.abs(current - target);

    if (currentDelta !== bestDelta) {
      return currentDelta < bestDelta ? current : best;
    }

    return current < best ? current : best;
  });
};

const pickSplitIndex = (text: string, speakerLabel: string | null, duration: number): number => {
  const safeChars = Math.max(MAX_CUE_CHARS - buildSpeakerPrefix(speakerLabel).length, 1);
  const targetChars = Math.min(text.length - 1, Math.max(1, Math.round(duration * TARGET_CPS)));
  const midpoint = Math.max(1, Math.min(text.length - 1, Math.round(text.length / 2)));
  const target = text.length > safeChars ? Math.min(safeChars, targetChars) : midpoint;

  const sentenceBoundary = chooseBoundaryPosition(text, getSentenceBoundaryPositions(text), target);
  if (sentenceBoundary !== null) return sentenceBoundary;

  const secondaryBoundary = chooseBoundaryPosition(text, getSecondaryBoundaryPositions(text), target);
  if (secondaryBoundary !== null) return secondaryBoundary;

  return midpoint;
};

const splitTextRecursively = (
  text: string,
  speakerLabel: string | null,
  duration: number,
  maxLineChars = DEFAULT_MAX_LINE_CHARS
): string[] => {
  const normalizedText = normalizeCueWhitespace(text);
  const probe: CueFragment = {
    text: normalizedText,
    startSec: 0,
    endSec: duration,
    speakerKey: null,
    speakerLabel,
    segments: [],
  };

  if (normalizedText.length <= 1) return [normalizedText];
  if (isCueWithinStructuralLimits(probe, maxLineChars)) return [normalizedText];

  const splitIndex = pickSplitIndex(normalizedText, speakerLabel, duration);
  let leftText = normalizeCueWhitespace(normalizedText.slice(0, splitIndex));
  let rightText = normalizeCueWhitespace(normalizedText.slice(splitIndex));

  if (!leftText || !rightText) {
    const fallbackIndex = Math.max(1, Math.min(normalizedText.length - 1, Math.round(normalizedText.length / 2)));
    leftText = normalizeCueWhitespace(normalizedText.slice(0, fallbackIndex));
    rightText = normalizeCueWhitespace(normalizedText.slice(fallbackIndex));
  }

  if (!leftText || !rightText) return [normalizedText];

  const totalChars = leftText.length + rightText.length;
  const leftDuration = duration * (leftText.length / totalChars);
  const rightDuration = Math.max(duration - leftDuration, 0.001);

  return [
    ...splitTextRecursively(leftText, speakerLabel, leftDuration, maxLineChars),
    ...splitTextRecursively(rightText, speakerLabel, rightDuration, maxLineChars),
  ];
};

const splitSegmentIntoFragments = (
  segment: NormalizedSubtitleSegment,
  maxLineChars = DEFAULT_MAX_LINE_CHARS
): CueFragment[] => {
  const pieces = splitTextRecursively(
    segment.text,
    segment.speakerLabel,
    segment.endSec - segment.startSec,
    maxLineChars
  );
  const totalChars = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const fragments: CueFragment[] = [];
  let cursor = segment.startSec;

  pieces.forEach((piece, index) => {
    const remaining = segment.endSec - cursor;
    const pieceDuration =
      index === pieces.length - 1 ? remaining : (segment.endSec - segment.startSec) * (piece.length / totalChars);
    const endSec = index === pieces.length - 1 ? segment.endSec : cursor + pieceDuration;

    fragments.push({
      text: piece,
      startSec: cursor,
      endSec,
      speakerKey: segment.speakerKey,
      speakerLabel: segment.speakerLabel,
      segments: [segment],
    });

    cursor = endSec;
  });

  return fragments;
};

const mergeFragments = (left: CueFragment, right: CueFragment): CueFragment => {
  return {
    text: normalizeCueWhitespace(`${left.text} ${right.text}`),
    startSec: left.startSec,
    endSec: right.endSec,
    speakerKey: left.speakerKey,
    speakerLabel: left.speakerLabel,
    segments: [...left.segments, ...right.segments],
  };
};

const shouldMergeFragments = (left: CueFragment, right: CueFragment, maxLineChars = DEFAULT_MAX_LINE_CHARS): boolean => {
  if (!isSameSpeaker(left, right)) return false;

  const merged = mergeFragments(left, right);
  if (!isCueWithinStructuralLimits(merged, maxLineChars)) return false;

  // Prefer to end the cue at a sentence boundary once the left side reads on its own. Without
  // this, word-level transcripts pack into arbitrary 84-character blocks that cut mid-sentence.
  if (
    endsWithSentencePunctuation(left.text) &&
    getCueCharCount(left.speakerLabel, left.text) >= SENTENCE_BREAK_MIN_CHARS
  ) {
    return false;
  }

  // Otherwise pack greedily up to the structural limits. This rebuilds readable cues from the
  // many short fragments produced by token-level (per-word) transcripts.
  return true;
};

const enforceMinDuration = (fragments: CueFragment[]): CueFragment[] => {
  return fragments.map((fragment, index) => {
    const duration = getCueDuration(fragment);
    if (duration >= MIN_CUE_DURATION_SEC) return fragment;

    const previous = fragments[index - 1];
    const next = fragments[index + 1];
    const requiredEnd = Math.min(fragment.startSec + MIN_CUE_DURATION_SEC, fragment.startSec + MAX_CUE_DURATION_SEC);
    const maxEnd = next ? Math.max(fragment.endSec, next.startSec) : requiredEnd;
    const extendedEnd = Math.min(requiredEnd, maxEnd);

    if (extendedEnd - fragment.startSec >= MIN_CUE_DURATION_SEC) {
      return { ...fragment, endSec: extendedEnd };
    }

    const requiredStart = Math.max(fragment.endSec - MIN_CUE_DURATION_SEC, 0);
    const minStart = previous ? previous.endSec : 0;
    const extendedStart = Math.max(requiredStart, minStart);

    if (fragment.endSec - extendedStart >= MIN_CUE_DURATION_SEC) {
      return { ...fragment, startSec: extendedStart };
    }

    return fragment;
  });
};

export const segmentSubtitleCues = (
  segments: NormalizedSubtitleSegment[],
  options: { maxLineChars?: number } = {}
): SubtitleCue[] => {
  const maxLineChars = options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  const fragments = segments.flatMap((segment) => splitSegmentIntoFragments(segment, maxLineChars));
  const mergedFragments: CueFragment[] = [];

  for (const fragment of fragments) {
    const current = mergedFragments.at(-1);
    if (!current || !shouldMergeFragments(current, fragment, maxLineChars)) {
      mergedFragments.push(fragment);
      continue;
    }

    mergedFragments[mergedFragments.length - 1] = mergeFragments(current, fragment);
  }

  return enforceMinDuration(mergedFragments).map((fragment) => {
    const lines = wrapCueText(fragment.speakerLabel, fragment.text, maxLineChars);
    return {
      startSec: fragment.startSec,
      endSec: fragment.endSec,
      speakerKey: fragment.speakerKey,
      speakerLabel: fragment.speakerLabel,
      lines,
      text: lines.join("\n"),
      segments: fragment.segments,
    };
  });
};

const formatSrtTimestamp = (seconds: number): string => {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);

  return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs
    .toString()
    .padStart(2, "0")},${ms.toString().padStart(3, "0")}`;
};

export const serializeSubtitleCues = (cues: SubtitleCue[], clipStartTime = 0): string => {
  let srtContent = "";
  let subtitleIndex = 1;

  for (const cue of cues) {
    const adjustedStart = Math.max(0, cue.startSec - clipStartTime);
    const adjustedEnd = Math.max(0, cue.endSec - clipStartTime);
    if (adjustedEnd <= adjustedStart) continue;

    srtContent += `${subtitleIndex}\n`;
    srtContent += `${formatSrtTimestamp(adjustedStart)} --> ${formatSrtTimestamp(adjustedEnd)}\n`;
    srtContent += `${cue.text}\n\n`;
    subtitleIndex += 1;
  }

  return srtContent;
};
