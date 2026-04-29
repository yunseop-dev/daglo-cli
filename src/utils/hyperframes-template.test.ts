import { describe, expect, it } from "vitest";
import { renderHyperframesIndexHtml } from "./hyperframes-template.js";

describe("hyperframes template", () => {
  const baseInput = {
    title: "How <to> & make \"AI\"",
    summary: "A short summary of what was said.",
    keywords: ["claude", "agents", "context"],
    duration: 600,
    audioPath: "assets/audio.mp3",
    captionsPath: "assets/captions.srt",
    cues: [
      { startSec: 1, endSec: 4, text: "Line one." },
      { startSec: 4.5, endSec: 8, text: "Line two with speaker.", speakerLabel: "Boris" },
    ],
    screenshots: [
      { path: "assets/screenshots/shot-01.jpg", startSec: 5, endSec: 60 },
      { path: "assets/screenshots/shot-02.jpg", startSec: 60, endSec: 120 },
    ],
    outroSentence: "That is all, thanks!",
  };

  it("escapes HTML in title, summary, and outro", () => {
    const html = renderHyperframesIndexHtml(baseInput);
    expect(html).not.toContain("<to>");
    expect(html).toContain("&lt;to&gt;");
    expect(html).toContain("&quot;AI&quot;");
    expect(html).toContain("That is all, thanks!");
  });

  it("emits an audio clip with correct data attributes", () => {
    const html = renderHyperframesIndexHtml(baseInput);
    expect(html).toContain('id="source-audio"');
    expect(html).toContain('data-track-index="0"');
    expect(html).toContain('data-duration="600.000"');
    expect(html).toContain('src="assets/audio.mp3"');
  });

  it("emits a screenshot for each entry on track 2", () => {
    const html = renderHyperframesIndexHtml(baseInput);
    expect((html.match(/class="clip shot"/g) || []).length).toBe(
      baseInput.screenshots.length
    );
    expect(html).toContain('src="assets/screenshots/shot-01.jpg"');
  });

  it("embeds cues data as JSON for the GSAP timeline", () => {
    const html = renderHyperframesIndexHtml(baseInput);
    expect(html).toContain('"t":"Line one."');
    expect(html).toContain('"spk":"Boris"');
  });

  it("registers a timeline keyed by composition id", () => {
    const html = renderHyperframesIndexHtml({
      ...baseInput,
      compositionId: "my-comp",
    });
    expect(html).toContain('window.__timelines["my-comp"]');
    expect(html).toContain('data-composition-id="my-comp"');
  });

  it("omits audio markup when no audioPath is provided", () => {
    const html = renderHyperframesIndexHtml({ ...baseInput, audioPath: undefined });
    expect(html).not.toContain('id="source-audio"');
  });
});
