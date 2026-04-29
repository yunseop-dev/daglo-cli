import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { DagloApiClient } from "../api/client.js";
import { logger } from "../logger.js";
import { GenerateHyperframesArgs } from "../schemas/hyperframes.js";
import {
  extractSegmentsFromScript,
  extractYouTubeId,
  fetchAllScriptPages,
  resolveSingleYouTubeUrl,
  type ScriptSegment,
} from "./video.js";
import { buildUrl, parseResponseBody } from "../utils/http.js";
import {
  buildKeywords,
  buildShotTimes,
  pickHighlights,
  summarizeTranscript,
} from "../utils/highlights.js";
import {
  CompositionCue,
  CompositionScreenshot,
  renderHyperframesIndexHtml,
} from "../utils/hyperframes-template.js";
import {
  type BriefAsset,
  type BriefHighlight,
  type BriefScreenshot,
  renderBriefMarkdown,
  renderDesignScaffold,
} from "../utils/hyperframes-brief.js";
import {
  segmentSubtitleCues,
  serializeSubtitleCues,
  type NormalizedSubtitleSegment,
} from "../utils/subtitles.js";

const toRelPosix = (root: string, target: string): string =>
  relative(root, target).split("\\").join("/");

const detectScaleToSeconds = (segments: ScriptSegment[], duration: number): number => {
  const maxEnd = segments.reduce((max, s) => Math.max(max, s.endTime), 0);
  const reference = Number.isFinite(duration) && duration > 0 ? duration * 10 : 10000;
  return maxEnd > Math.max(reference, 10000) ? 0.001 : 1;
};

const toNormalizedSegments = (
  scriptSegments: ScriptSegment[],
  scale: number
): NormalizedSubtitleSegment[] =>
  scriptSegments
    .filter((s) => s.text.trim().length > 0 && s.endTime > s.startTime)
    .map((s) => ({
      text: s.text,
      startSec: s.startTime * scale,
      endSec: s.endTime * scale,
      speakerKey: null,
      speakerLabel: null,
      raw: s,
    }));

const slugify = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "daglo-board";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const extractKeywordsFromBoard = (boardData: Record<string, unknown>): string[] => {
  const fileMeta = Array.isArray(boardData.fileMeta)
    ? (boardData.fileMeta as Array<Record<string, unknown>>)
    : [];
  const result: string[] = [];
  for (const meta of fileMeta) {
    const list = meta.transcriptKeywords;
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry === "string") result.push(entry);
      else if (isRecord(entry) && typeof entry.keyword === "string") {
        result.push(entry.keyword);
      }
    }
  }
  if (Array.isArray(boardData.keywords)) {
    for (const entry of boardData.keywords) {
      if (typeof entry === "string") result.push(entry);
      else if (isRecord(entry) && typeof entry.keyword === "string") {
        result.push(entry.keyword);
      }
    }
  }
  return result;
};

const fetchBoardData = async (
  client: DagloApiClient,
  boardId: string
): Promise<Record<string, unknown>> => {
  const url = buildUrl(client.baseUrl, `/boards/${boardId}`);
  const response = await client.request(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch board ${boardId}: ${response.statusText}`);
  }
  return (await parseResponseBody(response)) as Record<string, unknown>;
};

const fetchScriptEnvelope = async (
  client: DagloApiClient,
  fileMetaId: string
): Promise<Record<string, unknown> | null> => {
  const url = buildUrl(client.baseUrl, `/file-meta/${fileMetaId}/script`, {
    limit: 60,
    page: 0,
  });
  const response = await client.request(url);
  if (!response.ok) return null;
  return (await parseResponseBody(response)) as Record<string, unknown>;
};

const runCommand = (command: string, args: string[]): string => {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim();
};

const probeDurationSec = (videoPath: string): number => {
  const output = runCommand("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    videoPath,
  ]);
  const value = Number.parseFloat(output);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`ffprobe could not determine duration for ${videoPath}`);
  }
  return value;
};

const downloadYoutubeVideo = (youtubeUrl: string, destination: string): void => {
  if (existsSync(destination)) {
    logger.info({ path: destination }, "Video already downloaded, skipping");
    return;
  }
  logger.info({ url: youtubeUrl, path: destination }, "Downloading video via yt-dlp");
  execFileSync(
    "yt-dlp",
    [
      "-f",
      "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      "--merge-output-format",
      "mp4",
      "-o",
      destination,
      youtubeUrl,
    ],
    { stdio: "inherit" }
  );
  if (!existsSync(destination)) {
    throw new Error(`yt-dlp finished but ${destination} is missing`);
  }
};

const extractAudio = (videoPath: string, destination: string): void => {
  if (existsSync(destination)) {
    logger.info({ path: destination }, "Audio already extracted, skipping");
    return;
  }
  logger.info({ source: videoPath, path: destination }, "Extracting audio via ffmpeg");
  execFileSync(
    "ffmpeg",
    ["-y", "-i", videoPath, "-vn", "-ac", "2", "-ar", "44100", "-b:a", "192k", destination],
    { stdio: "inherit" }
  );
};

const extractScreenshot = (
  videoPath: string,
  timeSec: number,
  destination: string
): void => {
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-ss", timeSec.toFixed(3),
      "-i", videoPath,
      "-frames:v", "1",
      "-q:v", "2",
      destination,
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
};

const tryRunHyperframesInit = (
  outputDir: string,
  audioRel: string | null
): boolean => {
  const args = ["exec", "--yes", "--", "hyperframes", "init", outputDir];
  if (audioRel) args.push("--audio", audioRel);
  try {
    execFileSync("npm", args, { stdio: "inherit" });
    return true;
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "hyperframes init failed (will skip and write composition directly)"
    );
    return false;
  }
};

export type GenerateHyperframesResult = {
  outputDir: string;
  indexHtml: string | null;
  briefPath: string;
  designPath: string;
  manifestPath: string;
  captionsPath: string;
  transcriptPath: string;
  audioPath: string | null;
  videoPath: string | null;
  screenshotPaths: string[];
  cueCount: number;
  highlightCount: number;
  duration: number;
  followUp: string[];
};

export const generateHyperframesProject = async (
  client: DagloApiClient,
  args: GenerateHyperframesArgs
): Promise<GenerateHyperframesResult> => {
  const shots = args.shots ?? 4;
  const subtitleMaxLineLength = args.subtitleMaxLineLength ?? 42;

  const boardData = await fetchBoardData(client, args.boardId);
  const boardName =
    typeof boardData.name === "string" ? boardData.name : args.boardId;
  const compositionTitle = args.title ?? boardName;

  const outputDir = resolve(
    args.outputDir ?? join("hyperframes", slugify(compositionTitle))
  );
  const assetsDir = join(outputDir, "assets");
  const screenshotsDir = join(assetsDir, "screenshots");
  mkdirSync(screenshotsDir, { recursive: true });

  const fileMetaFromBoard =
    typeof boardData.fileMetaId === "string"
      ? boardData.fileMetaId
      : Array.isArray(boardData.fileMeta) &&
          isRecord(boardData.fileMeta[0]) &&
          typeof boardData.fileMeta[0].id === "string"
        ? (boardData.fileMeta[0].id as string)
        : undefined;
  const fileMetaId = args.fileMetaId ?? fileMetaFromBoard;

  if (!fileMetaId) {
    throw new Error(
      `Could not determine fileMetaId for board ${args.boardId}. Pass --file-meta.`
    );
  }

  const scripts = await fetchAllScriptPages(client, fileMetaId);
  if (scripts.length === 0) {
    throw new Error(`No script pages returned for fileMeta ${fileMetaId}`);
  }

  const sentenceSegments = scripts.flatMap((script) =>
    extractSegmentsFromScript(script as Record<string, unknown>)
  );
  if (sentenceSegments.length === 0) {
    throw new Error("No sentence-level segments could be extracted from the script");
  }

  let resolvedYoutubeUrl = args.youtubeUrl;
  if (!resolvedYoutubeUrl && !args.sourceVideo) {
    const sources: Array<[string, unknown]> = [["board", boardData]];
    try {
      const envelope = await fetchScriptEnvelope(client, fileMetaId);
      if (envelope) sources.push(["script-envelope", envelope]);
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "Could not fetch script envelope for URL resolution"
      );
    }
    sources.push(["script-content", scripts]);

    for (const [name, source] of sources) {
      try {
        const found = resolveSingleYouTubeUrl(source, args.boardId);
        if (found) {
          resolvedYoutubeUrl = found;
          logger.info({ source: name, url: found }, "Resolved YouTube URL");
          break;
        }
      } catch (error) {
        logger.warn(
          { source: name, error: error instanceof Error ? error.message : String(error) },
          "Multiple YouTube URLs in source; pass --youtube-url to disambiguate"
        );
      }
    }

    if (!resolvedYoutubeUrl) {
      logger.warn(
        { boardId: args.boardId },
        "No YouTube URL found anywhere; provide --source-video or --youtube-url"
      );
    }
  }

  let videoPath: string | null = null;
  if (args.sourceVideo) {
    videoPath = resolve(args.sourceVideo);
    if (!existsSync(videoPath)) {
      throw new Error(`--source-video does not exist: ${videoPath}`);
    }
  } else if (resolvedYoutubeUrl) {
    const youtubeId = extractYouTubeId(resolvedYoutubeUrl);
    const filename = youtubeId ? `video_${youtubeId}.mp4` : "video.mp4";
    videoPath = join(assetsDir, filename);
    downloadYoutubeVideo(resolvedYoutubeUrl, videoPath);
  }

  const probedDuration = videoPath ? probeDurationSec(videoPath) : 0;
  const scaleToSeconds = detectScaleToSeconds(sentenceSegments, probedDuration);
  const segments = toNormalizedSegments(sentenceSegments, scaleToSeconds);
  if (segments.length === 0) {
    throw new Error("No usable subtitle segments after normalization");
  }
  const segmentEnd = segments.at(-1)?.endSec ?? 0;
  const duration = probedDuration > 0 ? probedDuration : Math.max(segmentEnd, 1);

  const cues = segmentSubtitleCues(segments, { maxLineChars: subtitleMaxLineLength });
  const srtContent = serializeSubtitleCues(cues, 0);
  const captionsPath = join(assetsDir, "captions.srt");
  writeFileSync(captionsPath, srtContent, "utf8");

  let audioPath: string | null = null;
  if (args.sourceAudio) {
    audioPath = resolve(args.sourceAudio);
    if (!existsSync(audioPath)) {
      throw new Error(`--source-audio does not exist: ${audioPath}`);
    }
  } else if (videoPath) {
    audioPath = join(assetsDir, "audio.mp3");
    extractAudio(videoPath, audioPath);
  }

  const boardKeywords = extractKeywordsFromBoard(boardData);
  const keywords = buildKeywords(segments, { boardKeywords, max: 8 });
  const summary = summarizeTranscript(segments, { maxLength: 220 });

  const briefHighlights = pickHighlights(segments, 8, { preferredKeywords: keywords });
  const shotHighlights = briefHighlights.slice(0, shots);
  const shotTimes = buildShotTimes(duration, shotHighlights, shots);

  const screenshotPaths: string[] = [];
  if (videoPath && shotTimes.length > 0) {
    for (let index = 0; index < shotTimes.length; index += 1) {
      const filename = `shot-${String(index + 1).padStart(2, "0")}.jpg`;
      const destination = join(screenshotsDir, filename);
      try {
        extractScreenshot(videoPath, shotTimes[index], destination);
        screenshotPaths.push(destination);
      } catch (error) {
        logger.warn(
          { time: shotTimes[index], error: error instanceof Error ? error.message : String(error) },
          "Screenshot extraction failed"
        );
      }
    }
  }

  const compositionScreenshots: CompositionScreenshot[] = screenshotPaths.map(
    (shotPath, index) => {
      const startSec = shotTimes[index] ?? 0;
      const nextStart = shotTimes[index + 1] ?? duration;
      return {
        path: toRelPosix(outputDir, shotPath),
        startSec,
        endSec: Math.max(startSec + 0.5, nextStart),
      };
    }
  );

  const audioRel = audioPath ? toRelPosix(outputDir, audioPath) : undefined;
  const captionsRel = toRelPosix(outputDir, captionsPath);

  const transcriptPath = join(assetsDir, "transcript.json");
  const transcriptData = segments.map((segment) => ({
    startSec: Number(segment.startSec.toFixed(3)),
    endSec: Number(segment.endSec.toFixed(3)),
    text: segment.text,
    speakerLabel: segment.speakerLabel,
  }));
  writeFileSync(transcriptPath, `${JSON.stringify(transcriptData, null, 2)}\n`, "utf8");

  const briefHighlightsForDoc: BriefHighlight[] = briefHighlights.map((segment) => ({
    startSec: segment.startSec,
    endSec: segment.endSec,
    text: segment.text,
  }));

  const briefScreenshots: BriefScreenshot[] = compositionScreenshots.map((shot) => ({
    path: shot.path,
    startSec: shot.startSec,
    endSec: shot.endSec,
  }));

  const briefAssets: BriefAsset[] = [];
  if (audioRel) briefAssets.push({ label: "audio", path: audioRel, description: "extracted audio (mp3)" });
  if (videoPath && videoPath.startsWith(outputDir)) {
    briefAssets.push({
      label: "video",
      path: toRelPosix(outputDir, videoPath),
      description: "raw download from yt-dlp",
    });
  }
  briefAssets.push({ label: "captions", path: captionsRel, description: "SRT, sentence-level cues" });
  briefAssets.push({
    label: "transcript",
    path: toRelPosix(outputDir, transcriptPath),
    description: "JSON [{ startSec, endSec, text, speakerLabel }]",
  });
  briefAssets.push({ label: "manifest", path: "assets/manifest.json", description: "machine-readable summary" });

  const briefInput = {
    boardId: args.boardId,
    boardName,
    title: compositionTitle,
    duration,
    youtubeUrl: resolvedYoutubeUrl ?? null,
    keywords,
    summary,
    highlights: briefHighlightsForDoc,
    screenshots: briefScreenshots,
    assets: briefAssets,
    segments,
    outputDirName: outputDir,
  };

  const briefPath = join(outputDir, "BRIEF.md");
  writeFileSync(briefPath, renderBriefMarkdown(briefInput), "utf8");

  const designPath = join(outputDir, "DESIGN.md");
  if (!existsSync(designPath)) {
    writeFileSync(designPath, renderDesignScaffold(briefInput), "utf8");
  } else {
    logger.info({ path: designPath }, "DESIGN.md already exists, leaving untouched");
  }

  let indexHtmlPath: string | null = null;
  if (args.baseline) {
    if (!args.skipInit) {
      tryRunHyperframesInit(outputDir, audioRel ?? null);
    }
    const compositionCues: CompositionCue[] = cues.map((cue) => ({
      startSec: cue.startSec,
      endSec: cue.endSec,
      text: cue.text,
      speakerLabel: cue.speakerLabel,
    }));
    const html = renderHyperframesIndexHtml({
      title: compositionTitle,
      subtitle: `${cues.length} cues · ${briefHighlights.length} highlights`,
      summary,
      keywords,
      duration,
      audioPath: audioRel,
      captionsPath: captionsRel,
      cues: compositionCues,
      screenshots: compositionScreenshots,
      outroSentence: summary,
    });
    indexHtmlPath = join(outputDir, "index.html");
    writeFileSync(indexHtmlPath, html, "utf8");
  }

  const manifest = {
    boardId: args.boardId,
    boardName,
    title: compositionTitle,
    duration,
    fileMetaId,
    youtubeUrl: resolvedYoutubeUrl ?? null,
    keywords,
    summary,
    cueCount: cues.length,
    highlightCount: briefHighlights.length,
    screenshots: compositionScreenshots,
    briefHighlights: briefHighlightsForDoc.map((h) => ({
      startSec: Number(h.startSec.toFixed(3)),
      endSec: Number(h.endSec.toFixed(3)),
      text: h.text,
    })),
    audioPath: audioRel ?? null,
    captionsPath: captionsRel,
    transcriptPath: toRelPosix(outputDir, transcriptPath),
    baselineHtml: indexHtmlPath ? toRelPosix(outputDir, indexHtmlPath) : null,
  };
  const manifestPath = join(assetsDir, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const followUp = args.baseline
    ? [
        `npm exec --yes -- hyperframes lint ${outputDir}`,
        `npm exec --yes -- hyperframes preview ${outputDir}`,
        `npm exec --yes -- hyperframes render ${outputDir} --output ${join(outputDir, "out.mp4")}`,
      ]
    : [
        `1. Open ${briefPath}`,
        `   and ${designPath}`,
        `2. Run Claude Code in ${outputDir} and ask:`,
        `     "Read BRIEF.md and DESIGN.md, then build a HyperFrames composition`,
        `      in index.html using the hyperframes skill. Lint when done."`,
        `3. After Claude finishes:`,
        `     npm exec --yes -- hyperframes preview ${outputDir}`,
        `     npm exec --yes -- hyperframes render ${outputDir} --output ${join(outputDir, "out.mp4")}`,
      ];

  return {
    outputDir,
    indexHtml: indexHtmlPath,
    briefPath,
    designPath,
    manifestPath,
    captionsPath,
    transcriptPath,
    audioPath,
    videoPath,
    screenshotPaths,
    cueCount: cues.length,
    highlightCount: briefHighlights.length,
    duration,
    followUp,
  };
};
