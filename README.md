# Daglo CLI

Command-line interface for the Daglo AI platform — speech-to-text transcription, board management, Obsidian export, and YouTube subtitle/clip generation.

## Installation

```bash
npm install
npm run build
npm link    # registers `daglo` globally
```

## Authentication

```bash
daglo auth login                                         # interactive prompt
daglo auth login --email u@x.com --password '...'        # explicit args
DAGLO_EMAIL=... DAGLO_PASSWORD=... daglo auth login      # env vars
daglo auth status
daglo auth logout
```

Tokens cache to `~/.config/daglo/credentials.json` (file mode `0600`, dir mode `0700`). On expiry or 401 responses, the CLI re-logs in automatically using `DAGLO_EMAIL`/`DAGLO_PASSWORD` if set.

## Commands

| Group | Command | Description |
|---|---|---|
| auth | `daglo auth login\|logout\|status` | Authentication |
| board | `daglo board list` | List boards (`--page`, `--limit`, `--sort`, `--status`, `--starred`, `--folder`) |
| board | `daglo board info <id>` | Basic info (`--shared <id>` for shared boards) |
| board | `daglo board detail <id>` | Full detail with content/summary/segments |
| board | `daglo board script` | Decoded script (`--file-meta`, `--shared`, etc.) |
| board | `daglo board rename <id> <name>` | Rename a board |
| board | `daglo board latest` | Latest board's content |
| board | `daglo board export <format>` | Export to text or punctuation-json (`--out`) |
| folder | `daglo folder list` | List folders |
| folder | `daglo folder export <folderId>` | Bulk export to Obsidian |
| file-meta | `daglo file-meta get <id>` | Fetch file metadata |
| file-meta | `daglo file-meta keywords` | Keywords for a file or shared board |
| obsidian | `daglo obsidian export <boardId>` | Single-board Obsidian export |
| video | `daglo video clip <url>` | YouTube highlight clip with burned subtitles |
| video | `daglo video subtitle [youtubeUrl]` | Full subtitled video |

Run `daglo <group> --help` for per-command options.

## Global Options

- `--json` — machine-readable JSON output
- `--no-color` — disable color
- `-v, --verbose` — debug logging (stderr)
- `--quiet` — suppress info logs (stderr)

## Output

- **stdout** — command results (tables / JSON / file paths)
- **stderr** — progress markers, logs, errors

This makes `daglo board list --json | jq` pipe cleanly.

## External Tools

`daglo video clip` and `daglo video subtitle` shell out to:

- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) — YouTube download
- [`ffmpeg`](https://ffmpeg.org/) — clipping and subtitle burning

Install both and ensure they're on `PATH` before using video commands.

## HyperFrames Prototype

```bash
npm run hyperframes:building-pi
```

This generates a standalone HyperFrames project under `docs/hyperframes/building-pi/` using the included test board artifacts:

- `Building pi in a World of Slop — Mario Zechner.json`
- `2026-04-20-Building-pi-in-a-World-of-Slop-Mario-Zechner.txt`
- `latest-board-video.mp4`

The generator also accepts Daglo transcript JSON when you have a JSON export handy; the checked-in test board uses the plain-text transcript artifact in this repo.

The generator writes:

- `index.html` — HyperFrames composition
- `DESIGN.md` — palette + typography contract
- `README.md` — render instructions
- `assets/manifest.json` — derived metadata
- `assets/source-audio.mp3` and `assets/screenshots/` when FFmpeg can sample the source video

## Configuration

- `DAGLO_EMAIL` / `DAGLO_PASSWORD` — fallback credentials for re-auth
- `LOG_LEVEL` — pino log level (`debug` | `info` | `warn` | `error`)
- `XDG_CONFIG_HOME` — overrides `~/.config` for credential storage

## Development

```bash
npm test            # vitest
npm run test:ui
npm run build       # tsc + chmod +x dist/cli.js
npm link            # register `daglo` for local testing
```

## CLI Smoke Verification

```bash
npm run smoke:board-cli
```

This keeps the task-8 smoke contract pinned to the built `dist/cli.js` binary and verifies:

- board-id happy path → leaves `video_<id>.mp4`, `subtitles.srt`, and `video_with_subs.mp4` under `.sisyphus/evidence/task-8-board/`
- board-id happy path log is refreshed at `.sisyphus/evidence/task-8-board.log`
- built CLI direct URL + `--file-meta` regression smoke leaves artifacts under `.sisyphus/evidence/task-8-direct-url-file-meta/`
- built CLI smoke logs stay under `.sisyphus/evidence/task-8-cli-smoke/` and include the latest stderr/stdout snapshots plus ffprobe evidence
- board-id failure paths for multiple YouTube URLs, no resolvable YouTube URL, and empty transcript all fail via built CLI before writing media artifacts
- `--file-meta` only → schema rejection message from the built CLI
- task-6 verification artifacts remain under `.sisyphus/evidence/task-6-board-subtitle/` and are not repurposed by `npm run smoke:board-cli`

## License

MIT
