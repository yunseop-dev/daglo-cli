import { Command } from "commander";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createYoutubeFullSubtitledVideoCommandSchema } from "../schemas/video.js";
import { registerVideoCommand } from "./video.js";

vi.mock("../handlers/video.js", () => ({
  createYoutubeHighlightClip: vi.fn(),
  createYoutubeFullSubtitledVideo: vi.fn().mockResolvedValue({
    videoPath: "/tmp/video.mp4",
    srtPath: "/tmp/video.srt",
    finalPath: "/tmp/video-final.mp4",
  }),
}));

describe("video subtitle command contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const buildProgram = () => {
    const program = new Command();
    registerVideoCommand(program, {} as never);
    const video = program.commands.find((command) => command.name() === "video");
    if (!video) throw new Error("video command not registered");
    const subtitle = video.commands.find((command) => command.name() === "subtitle");
    if (!subtitle) throw new Error("subtitle command not registered");
    return { program, subtitle };
  };

  it("shows an optional youtubeUrl positional in help", () => {
    const { subtitle } = buildProgram();
    expect(subtitle.helpInformation()).toContain("subtitle [options] [youtubeUrl]");
  });

  it("accepts boardId without youtubeUrl", () => {
    const result = createYoutubeFullSubtitledVideoCommandSchema.safeParse({
      boardId: "board-1",
    });

    expect(result.success).toBe(true);
  });

  it("rejects fileMetaId without boardId with the expected message", () => {
    const result = createYoutubeFullSubtitledVideoCommandSchema.safeParse({
      fileMetaId: "fm1",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(
        "Provide <youtubeUrl> when using --file-meta without --board-id."
      );
    }
  });

  it("accepts youtubeUrl + fileMetaId without boardId", () => {
    const result = createYoutubeFullSubtitledVideoCommandSchema.safeParse({
      youtubeUrl: "https://www.youtube.com/watch?v=directsmoke01",
      fileMetaId: "fm1",
    });

    expect(result.success).toBe(true);
  });
});
