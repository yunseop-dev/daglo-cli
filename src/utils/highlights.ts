import type { NormalizedSubtitleSegment } from "./subtitles.js";

const STOP_WORDS = new Set<string>([
  "a", "an", "and", "are", "as", "at", "be", "because", "been", "but", "by",
  "can", "could", "did", "do", "does", "doing", "for", "from", "had", "has",
  "have", "he", "her", "here", "him", "his", "how", "i", "if", "in", "into",
  "is", "it", "its", "just", "me", "more", "my", "not", "of", "on", "or",
  "our", "out", "so", "than", "that", "the", "their", "them", "then", "there",
  "these", "they", "this", "to", "too", "we", "what", "when", "where", "which",
  "who", "why", "with", "you", "your", "was", "were", "will", "would", "don't",
  "here's", "it's", "that's", "you're", "we're", "they're", "there's", "what's",
  "can't", "won't", "isn't", "aren't", "wasn't", "weren't", "i'm", "we'll",
  "you'll", "they'll",
]);

const sanitize = (value: string): string => value.replace(/\s+/g, " ").trim();

const tokenizeWords = (text: string, minLen = 3): string[] =>
  (text.match(/[A-Za-z][A-Za-z'-]+/g) || [])
    .map((word) => word.toLowerCase())
    .filter((word) => word.length >= minLen);

export const buildKeywords = (
  segments: NormalizedSubtitleSegment[],
  options: { boardKeywords?: string[]; max?: number } = {}
): string[] => {
  const max = options.max ?? 8;
  const boardKeywords = (options.boardKeywords ?? [])
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  const boost = new Set(boardKeywords);

  const counts = new Map<string, number>();
  for (const segment of segments) {
    for (const word of tokenizeWords(segment.text, 4)) {
      if (STOP_WORDS.has(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }

  const ranked = [...counts.entries()]
    .map(([word, count]) => ({
      word,
      score: count + (boost.has(word) ? 6 : 0),
      count,
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.count !== a.count) return b.count - a.count;
      return a.word.localeCompare(b.word);
    });

  const ordered: string[] = [];
  for (const kw of boardKeywords) {
    if (!ordered.includes(kw)) ordered.push(kw);
  }
  for (const { word } of ranked) {
    if (ordered.length >= max) break;
    if (!ordered.includes(word)) ordered.push(word);
  }
  return ordered.slice(0, max);
};

const scoreSegment = (
  segment: NormalizedSubtitleSegment,
  preferredKeywords: Set<string>
): number => {
  const text = sanitize(segment.text);
  const words = tokenizeWords(text);
  const wordCount = words.length;
  const uniqueContent = new Set(words.filter((word) => !STOP_WORDS.has(word)));
  let score = uniqueContent.size * 2 + Math.min(text.length / 20, 4);

  if (preferredKeywords.size > 0) {
    const lower = text.toLowerCase();
    for (const keyword of preferredKeywords) {
      if (lower.includes(keyword)) score += 3;
    }
  }

  if (/[.!?]/.test(text)) score += 1;
  if (text.includes(",")) score += 0.5;
  if (wordCount > 18 && wordCount < 50) score += 1;
  if (wordCount < 5) score -= 2;
  if (text.length > 240) score -= 1.5;
  return score;
};

export const pickHighlights = (
  segments: NormalizedSubtitleSegment[],
  count: number,
  options: { preferredKeywords?: string[] } = {}
): NormalizedSubtitleSegment[] => {
  if (segments.length === 0 || count <= 0) return [];

  const preferred = new Set(
    (options.preferredKeywords ?? []).map((k) => k.toLowerCase())
  );

  const cap = Math.min(count, segments.length);
  const ratios =
    cap <= 1
      ? [0.5]
      : Array.from({ length: cap }, (_, index) => (index + 1) / (cap + 1));

  const used = new Set<number>();
  const result: NormalizedSubtitleSegment[] = [];

  for (const ratio of ratios) {
    const targetIndex = Math.round((segments.length - 1) * ratio);
    const windowStart = Math.max(0, targetIndex - 4);
    const windowEnd = Math.min(segments.length, targetIndex + 5);

    let chosenIndex: number | null = null;
    let chosenScore = -Infinity;
    let chosenDistance = Infinity;
    for (let index = windowStart; index < windowEnd; index += 1) {
      if (used.has(index)) continue;
      const score = scoreSegment(segments[index], preferred);
      const distance = Math.abs(index - targetIndex);
      if (
        score > chosenScore ||
        (score === chosenScore && distance < chosenDistance)
      ) {
        chosenScore = score;
        chosenDistance = distance;
        chosenIndex = index;
      }
    }

    if (chosenIndex === null) {
      for (let index = 0; index < segments.length; index += 1) {
        if (!used.has(index)) {
          chosenIndex = index;
          break;
        }
      }
    }

    if (chosenIndex === null) break;
    used.add(chosenIndex);
    result.push(segments[chosenIndex]);
  }

  return result;
};

export const summarizeTranscript = (
  segments: NormalizedSubtitleSegment[],
  options: { maxLength?: number } = {}
): string => {
  const maxLength = options.maxLength ?? 220;
  const meaningful = segments
    .map((segment) => sanitize(segment.text))
    .filter((text) => text.length > 50)
    .slice(0, 3);

  const fallback = segments
    .slice(0, 2)
    .map((segment) => sanitize(segment.text))
    .join(" ");

  const summary = meaningful.length ? meaningful.join(" ") : fallback;
  if (summary.length <= maxLength) return summary;
  return `${summary.slice(0, maxLength).trim()}…`;
};

export const buildShotTimes = (
  duration: number,
  highlights: NormalizedSubtitleSegment[],
  count: number
): number[] => {
  if (!Number.isFinite(duration) || duration <= 0 || count <= 0) return [];

  const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), max);

  const fallback =
    count <= 1
      ? [0.5]
      : Array.from({ length: count }, (_, index) => (index + 1) / (count + 1));

  const minTime = Math.min(3, duration * 0.05);
  const maxTime = Math.max(minTime, duration - 3);

  const times: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const highlight = highlights[index];
    if (highlight) {
      const midpoint = (highlight.startSec + highlight.endSec) / 2;
      times.push(clamp(midpoint, minTime, maxTime));
      continue;
    }
    times.push(clamp(duration * fallback[index], minTime, maxTime));
  }
  return times;
};
