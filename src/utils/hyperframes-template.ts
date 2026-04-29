export type CompositionCue = {
  startSec: number;
  endSec: number;
  text: string;
  speakerLabel?: string | null;
};

export type CompositionScreenshot = {
  path: string;
  startSec: number;
  endSec: number;
};

export type CompositionInput = {
  compositionId?: string;
  title: string;
  subtitle?: string;
  summary: string;
  keywords: string[];
  duration: number;
  audioPath?: string;
  captionsPath?: string;
  cues: CompositionCue[];
  screenshots: CompositionScreenshot[];
  outroSentence?: string;
  width?: number;
  height?: number;
};

const escapeHtml = (value: string): string =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const escapeJs = (value: unknown): string => JSON.stringify(value);

const formatHms = (seconds: number): string => {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  if (hours > 0) {
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
};

export const renderHyperframesIndexHtml = (input: CompositionInput): string => {
  const compositionId = input.compositionId ?? "daglo-board";
  const width = input.width ?? 1920;
  const height = input.height ?? 1080;
  const duration = Math.max(input.duration, 1);

  const screenshotMarkup = input.screenshots
    .map(
      (shot, index) => `        <img
          id="shot-${index}"
          class="clip shot"
          data-start="${shot.startSec.toFixed(3)}"
          data-duration="${(shot.endSec - shot.startSec).toFixed(3)}"
          data-track-index="2"
          src="${escapeHtml(shot.path)}"
          alt="Highlight screenshot ${index + 1}" />`
    )
    .join("\n");

  const keywordChips = input.keywords
    .slice(0, 8)
    .map((keyword) => `<span class="chip">${escapeHtml(keyword)}</span>`)
    .join("");

  const audioMarkup = input.audioPath
    ? `      <audio
        id="source-audio"
        class="clip"
        data-start="0"
        data-duration="${duration.toFixed(3)}"
        data-track-index="0"
        data-volume="1"
        src="${escapeHtml(input.audioPath)}"></audio>`
    : "";

  const cuesData = input.cues.map((cue) => ({
    s: Number(cue.startSec.toFixed(3)),
    e: Number(cue.endSec.toFixed(3)),
    t: cue.text,
    spk: cue.speakerLabel ?? null,
  }));

  const screenshotsData = input.screenshots.map((shot) => ({
    s: Number(shot.startSec.toFixed(3)),
    e: Number(shot.endSec.toFixed(3)),
  }));

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.title)} — Daglo × HyperFrames</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0d1321;
        --surface: rgba(29, 45, 68, 0.84);
        --surface-strong: rgba(19, 30, 49, 0.95);
        --fg: #f0ebd8;
        --muted: rgba(240, 235, 216, 0.72);
        --accent: #2ec4b6;
        --accent-warm: #fca311;
      }
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        background: var(--bg);
        overflow: hidden;
        font-family: "IBM Plex Sans", system-ui, sans-serif;
        color: var(--fg);
      }
      [data-composition-id="${escapeHtml(compositionId)}"] {
        position: relative;
        width: 100%;
        height: 100%;
        background:
          radial-gradient(circle at 18% 20%, rgba(46, 196, 182, 0.18), transparent 28%),
          radial-gradient(circle at 82% 24%, rgba(252, 163, 17, 0.14), transparent 24%),
          linear-gradient(160deg, #0d1321 0%, #101a2a 40%, #0d1321 100%);
        box-sizing: border-box;
        padding: 72px 88px 96px;
        display: grid;
        grid-template-rows: auto 1fr auto;
        gap: 32px;
      }
      .grid-overlay {
        position: absolute; inset: 0; pointer-events: none;
        background-image:
          linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px);
        background-size: 72px 72px;
        mask-image: linear-gradient(180deg, rgba(0,0,0,0.34), rgba(0,0,0,0));
      }
      .header {
        position: relative; z-index: 2;
        display: flex; flex-direction: column; gap: 14px;
      }
      .eyebrow {
        margin: 0; font-size: 14px; letter-spacing: 0.2em;
        text-transform: uppercase; color: var(--accent);
        font-family: "IBM Plex Mono", ui-monospace, monospace;
      }
      .title {
        margin: 0; font-size: 56px; line-height: 1.05;
        letter-spacing: -0.04em; font-weight: 800;
        max-width: 22ch;
      }
      .meta-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
      .chip, .meta-pill {
        display: inline-flex; align-items: center; gap: 8px;
        padding: 8px 12px; border-radius: 999px;
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.07);
        font-size: 13px;
        font-family: "IBM Plex Mono", ui-monospace, monospace;
      }
      .chip { text-transform: lowercase; color: var(--fg); }
      .meta-pill { color: var(--muted); }
      .stage {
        position: relative; z-index: 2;
        border-radius: 32px; overflow: hidden;
        background: var(--surface-strong);
        border: 1px solid rgba(255,255,255,0.08);
        box-shadow: 0 24px 80px rgba(0,0,0,0.35);
      }
      .stage .shot {
        position: absolute; inset: 0;
        width: 100%; height: 100%;
        object-fit: cover;
        opacity: 0;
      }
      .stage .shot.is-active { opacity: 1; }
      .stage::after {
        content: "";
        position: absolute; inset: 0;
        background: linear-gradient(180deg, rgba(13,19,33,0) 50%, rgba(13,19,33,0.55) 100%);
        pointer-events: none;
      }
      .caption-box {
        position: relative; z-index: 2;
        padding: 24px 28px;
        border-radius: 24px;
        background: var(--surface);
        border: 1px solid rgba(255,255,255,0.09);
        backdrop-filter: blur(12px);
        min-height: 96px;
        display: flex; flex-direction: column; gap: 10px;
      }
      .caption-speaker {
        margin: 0; font-size: 12px; letter-spacing: 0.18em;
        text-transform: uppercase; color: var(--accent);
        font-family: "IBM Plex Mono", ui-monospace, monospace;
        opacity: 0;
      }
      .caption-speaker.is-visible { opacity: 1; }
      .caption-text {
        margin: 0; font-size: 30px; line-height: 1.35;
        letter-spacing: -0.01em; font-weight: 500;
        white-space: pre-line;
      }
      .progress {
        position: absolute; left: 0; bottom: 0;
        height: 3px; width: 0%;
        background: linear-gradient(90deg, var(--accent), var(--accent-warm));
      }
      .summary {
        position: absolute;
        right: 96px; bottom: 132px;
        max-width: 38ch;
        font-size: 16px; line-height: 1.5; color: var(--muted);
      }
      audio { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
      .clip { visibility: hidden; }
    </style>
  </head>
  <body>
    <div data-composition-id="${escapeHtml(compositionId)}"
         data-start="0"
         data-width="${width}"
         data-height="${height}"
         class="composition-root">
      <div class="grid-overlay"></div>
      <header class="header">
        <p class="eyebrow">Daglo transcription · HyperFrames render</p>
        <h1 class="title">${escapeHtml(input.title)}</h1>
        <div class="meta-row">
          <span class="meta-pill">${escapeHtml(input.subtitle ?? `${input.cues.length} cues · ${formatHms(duration)}`)}</span>
          ${keywordChips}
        </div>
      </header>

      <div class="stage" id="stage">
${screenshotMarkup}
      </div>

      <section class="caption-box">
        <p class="caption-speaker" id="caption-speaker"></p>
        <p class="caption-text" id="caption-text">${escapeHtml(input.summary)}</p>
        <div class="progress" id="progress"></div>
      </section>

      ${input.outroSentence ? `<aside class="summary">${escapeHtml(input.outroSentence)}</aside>` : ""}

${audioMarkup}

      <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
      <script>
        window.__timelines = window.__timelines || {};
        const compositionDuration = ${duration.toFixed(3)};
        const cues = ${escapeJs(cuesData)};
        const shotWindows = ${escapeJs(screenshotsData)};
        const captionEl = document.getElementById("caption-text");
        const speakerEl = document.getElementById("caption-speaker");
        const progressEl = document.getElementById("progress");
        const shots = Array.from(document.querySelectorAll(".stage .shot"));
        const initialCaption = captionEl.textContent;
        const tl = gsap.timeline({ paused: true });

        cues.forEach((cue) => {
          tl.call(() => {
            captionEl.textContent = cue.t;
            if (cue.spk) {
              speakerEl.textContent = cue.spk;
              speakerEl.classList.add("is-visible");
            } else {
              speakerEl.classList.remove("is-visible");
            }
          }, [], cue.s);
        });

        if (cues.length > 0) {
          const lastCue = cues[cues.length - 1];
          tl.call(() => {
            captionEl.textContent = initialCaption;
            speakerEl.classList.remove("is-visible");
          }, [], Math.min(compositionDuration, lastCue.e + 0.05));
        }

        shotWindows.forEach((shot, index) => {
          const el = shots[index];
          if (!el) return;
          tl.call(() => {
            shots.forEach((other) => other.classList.remove("is-active"));
            el.classList.add("is-active");
          }, [], shot.s);
        });

        if (shots.length > 0) {
          tl.call(() => shots[0].classList.add("is-active"), [], 0);
        }

        tl.fromTo(
          progressEl,
          { width: "0%" },
          { width: "100%", duration: compositionDuration, ease: "none" },
          0
        );

        tl.to({}, { duration: compositionDuration }, 0);

        window.__timelines[${escapeJs(compositionId)}] = tl;
      </script>
    </div>
  </body>
</html>
`;
};
