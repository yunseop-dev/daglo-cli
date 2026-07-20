#!/usr/bin/env node
// Daglo 보드 마이그레이션 스크립트
//
//   node migrate.mjs [--folder <id>] [--force] [--dry-run] [--concurrency <n>] [--no-audio]
//
// 폴더 ID 를 주면 그 폴더만, 생략하면 전체 보드를 마이그레이션한다.
// 결과: output/<year>/<month>/<day>/<boardId>-<제목>/ (KST 기준)
//        ├── script.json      받아쓰기 원본 JSON 응답
//        ├── transcript.txt   받아쓰기 텍스트 전문
//        └── audio.<ext>      (FILE/RECORD) 원본 음성  또는
//            youtube.txt      (ONLINE_MEDIA) 원본 URL + yt-dlp 명령

import { execFile, execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { get as httpsGet } from "node:https";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------- config / args
const OUT_ROOT = resolve(process.cwd(), "output");
const PAGE_SIZE = 500;

function parseArgs(argv) {
  const a = { folder: null, force: false, dryRun: false, concurrency: 5, audio: true };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--folder") a.folder = argv[++i];
    else if (t === "--force") a.force = true;
    else if (t === "--dry-run") a.dryRun = true;
    else if (t === "--no-audio") a.audio = false;
    else if (t === "--concurrency") a.concurrency = Math.max(1, parseInt(argv[++i], 10) || 5);
    else throw new Error(`Unknown arg: ${t}`);
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------- daglo helpers
// daglo CLI 는 stderr 로 TLS 경고를 뿜으므로 성공 시 stdout 만 쓴다.
// 실패 시에는 stderr(실제 에러)를 캡처해 그대로 노출한다.
const EXEC_OPTS = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };

// daglo 가 항상 뱉는 TLS 경고 등 노이즈 라인을 걸러낸다.
function cleanStderr(stderr) {
  return String(stderr || "")
    .split("\n")
    .filter((l) => l.trim() && !/NODE_TLS_REJECT_UNAUTHORIZED|trace-warnings|^\(node:\d+\)/.test(l))
    .join("\n")
    .trim();
}

function dagloError(cliArgs, e) {
  const cmd = `daglo ${cliArgs.join(" ")}`;
  if (e.code === "ENOENT") {
    return new Error(
      `'daglo' 명령을 찾을 수 없습니다. daglo CLI 설치 및 PATH 를 확인하세요 (which daglo).`
    );
  }
  const stderr = cleanStderr(e.stderr);
  const exit = e.status ?? e.code ?? "?";
  return new Error(`${cmd} 실패 (exit ${exit}):\n${stderr || e.message}`);
}

function parseJsonOrThrow(cliArgs, out) {
  try {
    return JSON.parse(out);
  } catch (e) {
    throw new Error(
      `daglo ${cliArgs.join(" ")} 출력 JSON 파싱 실패: ${e.message}\n` +
        `--- 출력 앞부분 ---\n${String(out).slice(0, 500)}`
    );
  }
}

function dagloJson(cliArgs) {
  let out;
  try {
    out = execFileSync("daglo", cliArgs, { ...EXEC_OPTS, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    throw dagloError(cliArgs, e);
  }
  return parseJsonOrThrow(cliArgs, out);
}

async function dagloJsonAsync(cliArgs) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("daglo", cliArgs, EXEC_OPTS));
  } catch (e) {
    throw dagloError(cliArgs, e);
  }
  return parseJsonOrThrow(cliArgs, stdout);
}

async function dagloRun(cliArgs) {
  try {
    await execFileAsync("daglo", cliArgs, EXEC_OPTS);
  } catch (e) {
    throw dagloError(cliArgs, e);
  }
}

// 시작 전 daglo 존재/로그인 여부를 먼저 확인해 친절한 메시지를 준다.
function preflight() {
  let status;
  try {
    status = execFileSync("daglo", ["auth", "status"], { ...EXEC_OPTS, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    if (e.code === "ENOENT") {
      throw new Error(`'daglo' 명령을 찾을 수 없습니다. daglo CLI 설치 및 PATH 를 확인하세요.`);
    }
    throw new Error(
      `daglo 로그인 상태 확인 실패. 'daglo auth login' 으로 로그인했는지 확인하세요.\n` +
        (cleanStderr(e.stderr) || e.message)
    );
  }
  if (!/Email/i.test(status)) {
    throw new Error(`daglo 에 로그인돼 있지 않은 것 같습니다. 'daglo auth login' 을 먼저 실행하세요.\n${status.trim()}`);
  }
}

// ---------------------------------------------------------------- utils
function sanitize(name) {
  let s = String(name ?? "")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_") // 파일시스템 금지 문자 + 제어문자
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, ""); // 끝의 점/공백 제거 (Windows 호환)
  if (s.length > 150) s = s.slice(0, 150).trim();
  return s;
}

// createTime(UTC ISO) → KST 기준 {y, m, d}
function kstParts(iso) {
  const t = new Date(iso);
  const k = new Date(t.getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return { y: String(k.getUTCFullYear()), m: p(k.getUTCMonth() + 1), d: p(k.getUTCDate()) };
}

function nonEmptyFile(p) {
  try {
    return statSync(p).size > 0;
  } catch {
    return false;
  }
}

function extFromUrl(url, fallback = "m4a") {
  try {
    const path = new URL(url).pathname;
    const m = path.match(/\.([a-zA-Z0-9]{1,5})$/);
    return m ? m[1].toLowerCase() : fallback;
  } catch {
    return fallback;
  }
}

function downloadFile(url, dest, redirects = 5) {
  return new Promise((resolvePromise, reject) => {
    const req = httpsGet(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error("Too many redirects"));
        return downloadFile(res.headers.location, dest, redirects - 1).then(resolvePromise, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for audio download`));
      }
      const tmp = `${dest}.part`;
      const ws = createWriteStream(tmp);
      res.pipe(ws);
      ws.on("finish", () => ws.close(() => {
        try {
          renameSync(tmp, dest); // atomic-ish
          resolvePromise();
        } catch (e) {
          reject(e);
        }
      }));
      ws.on("error", reject);
    });
    req.on("error", reject);
  });
}

// script(editorState) 트리에서 karaoke 텍스트를 순서대로 이어붙여 전사문을 만든다.
// CLI 의 `board export text` 가 특정 스키마(version:1, e 없는 토큰)에서 빈 결과를 내므로 폴백으로 사용.
function buildTranscriptFromScript(script) {
  const parts = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === "speaker-block") parts.push("\n");
    if (node.type === "karaoke" && typeof node.text === "string") parts.push(node.text);
    if (node.children) walk(node.children);
  };
  const es = script?.editorState ?? script;
  walk(es?.root ?? es);
  return parts.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function ytDlpTxt(board, url) {
  const q = `"${url}"`;
  return [
    `# Source: YouTube / online media (ONLINE_MEDIA)`,
    `# Board: ${board.name ?? board.id}`,
    `# Board ID: ${board.id}`,
    `# URL: ${url}`,
    ``,
    `# 오디오(m4a)만:`,
    `yt-dlp -x --audio-format m4a -o "audio.%(ext)s" ${q}`,
    ``,
    `# 영상 최고화질:`,
    `yt-dlp -o "video.%(ext)s" ${q}`,
    ``,
  ].join("\n");
}

// ---------------------------------------------------------------- collect boards
function collectBoards() {
  const all = [];
  let page = 1;
  let totalPages = 1;
  do {
    const data = dagloJson(["board", "list", "--page", String(page), "--limit", String(PAGE_SIZE), "--json"]);
    const items = Array.isArray(data) ? data : data.items ?? [];
    all.push(...items);
    totalPages = data?.meta?.totalPages ?? 1;
    page += 1;
  } while (page <= totalPages);
  return all;
}

// ---------------------------------------------------------------- per-board work
async function migrateBoard(board, idx, total) {
  const boardId = board.id;
  const fileMetaId = board.fileMetaId;
  const { y, m, d } = kstParts(board.createTime);
  const dirName = `${boardId}-${sanitize(board.name) || boardId}`;
  const leaf = join(OUT_ROOT, y, m, d, dirName);

  const scriptPath = join(leaf, "script.json");
  const transcriptPath = join(leaf, "transcript.txt");
  const isYoutube = board.uploadType === "ONLINE_MEDIA";
  const audioMarkerPath = isYoutube ? join(leaf, "youtube.txt") : null;

  const rel = leaf.replace(`${process.cwd()}/`, "");

  if (args.dryRun) {
    console.log(`[dry] ${rel}  (${board.uploadType})`);
    return { boardId, name: board.name, createTime: board.createTime, folderId: board.folderId,
      uploadType: board.uploadType, sourceUrl: null, path: rel, status: "dry" };
  }

  // resume: 필요한 산출물이 모두 채워져 있으면 skip
  const audioSatisfied = isYoutube
    ? nonEmptyFile(audioMarkerPath)
    : !args.audio || existsSync(leaf) && findExistingAudio(leaf);
  if (!args.force && nonEmptyFile(scriptPath) && nonEmptyFile(transcriptPath) && audioSatisfied) {
    console.error(`[${idx}/${total}] skip (exists) ${rel}`);
    return { boardId, name: board.name, createTime: board.createTime, folderId: board.folderId,
      uploadType: board.uploadType, sourceUrl: null, path: rel, status: "skipped" };
  }

  mkdirSync(leaf, { recursive: true });

  // 1) script.json (raw) — 응답에 signedUrl 포함
  const script = await dagloJsonAsync(["board", "script", "--file-meta", fileMetaId, "--json"]);
  writeFileSync(scriptPath, JSON.stringify(script, null, 2), "utf8");
  const signedUrl = script?.meta?.signedUrl ?? null;

  // 2) transcript.txt — CLI export 시도, 빈 결과면 script.json 에서 직접 생성(폴백)
  await dagloRun(["board", "export", "text", "--board-id", boardId, "--file-meta", fileMetaId, "--out", transcriptPath]);
  if (!nonEmptyFile(transcriptPath)) {
    const fallback = buildTranscriptFromScript(script?.script ?? script);
    if (fallback.trim()) {
      writeFileSync(transcriptPath, fallback, "utf8");
      console.error(`[${idx}/${total}] transcript fallback(from script.json) ${boardId}`);
    } else {
      console.error(`[${idx}/${total}] warn: empty transcript for ${boardId}`);
    }
  }

  // 3) 음원 분기
  let sourceUrl = null;
  if (isYoutube) {
    let url = null;
    try {
      const fm = await dagloJsonAsync(["file-meta", "get", fileMetaId, "--json"]);
      url = fm?.file?.onlineMedia?.url ?? null;
    } catch (e) {
      console.error(`[${idx}/${total}] warn: file-meta get failed for ${boardId}: ${e.message}`);
    }
    if (url) {
      sourceUrl = url;
      writeFileSync(audioMarkerPath, ytDlpTxt(board, url), "utf8");
    } else {
      console.error(`[${idx}/${total}] warn: no online-media url for ${boardId}, youtube.txt 미생성`);
    }
  } else if (args.audio) {
    if (signedUrl) {
      const ext = extFromUrl(signedUrl, "m4a");
      const audioPath = join(leaf, `audio.${ext}`);
      if (args.force || !nonEmptyFile(audioPath)) {
        await downloadFile(signedUrl, audioPath);
      }
    } else {
      console.error(`[${idx}/${total}] warn: no signedUrl for ${boardId}, 오디오 skip`);
    }
  }

  console.error(`[${idx}/${total}] done ${rel}`);
  return { boardId, name: board.name, createTime: board.createTime, folderId: board.folderId,
    uploadType: board.uploadType, sourceUrl, path: rel, status: "ok" };
}

// leaf 안에 audio.* 가 이미 있는지
function findExistingAudio(leaf) {
  try {
    return readdirSync(leaf).some((f) => /^audio\./.test(f));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- concurrency pool
async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function loop() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, loop));
  return results;
}

// ---------------------------------------------------------------- main
async function main() {
  preflight();
  console.error(`Collecting boards...`);
  const boards = collectBoards();
  console.error(`Total boards fetched: ${boards.length}`);

  let scoped = boards;
  if (args.folder) scoped = boards.filter((b) => b.folderId === args.folder);

  const targets = [];
  const skippedReasons = [];
  for (const b of scoped) {
    if (b.status !== "COMPLETE") { skippedReasons.push([b.id, `status=${b.status}`]); continue; }
    if (!b.fileMetaId) { skippedReasons.push([b.id, "no fileMetaId"]); continue; }
    targets.push(b);
  }

  console.error(`Scope: ${scoped.length} boards${args.folder ? ` in folder ${args.folder}` : " (all)"}`);
  console.error(`Eligible targets: ${targets.length}, pre-skipped: ${skippedReasons.length}`);
  if (skippedReasons.length) {
    for (const [id, why] of skippedReasons.slice(0, 20)) console.error(`  - skip ${id}: ${why}`);
    if (skippedReasons.length > 20) console.error(`  ... and ${skippedReasons.length - 20} more`);
  }

  const total = targets.length;
  const errors = [];
  const manifest = [];

  const results = await runPool(
    targets,
    async (board, i) => {
      try {
        return await migrateBoard(board, i + 1, total);
      } catch (e) {
        errors.push([board.id, e.message]);
        console.error(`[${i + 1}/${total}] ERROR ${board.id}: ${e.message}`);
        return { boardId: board.id, name: board.name, createTime: board.createTime,
          folderId: board.folderId, uploadType: board.uploadType, sourceUrl: null, path: null, status: "error" };
      }
    },
    args.concurrency
  );

  manifest.push(...results.filter(Boolean));

  if (!args.dryRun) {
    mkdirSync(OUT_ROOT, { recursive: true });
    writeFileSync(join(OUT_ROOT, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  }

  // summary
  const count = (s) => manifest.filter((r) => r.status === s).length;
  const youtubeCount = manifest.filter((r) => r.status === "ok" && r.uploadType === "ONLINE_MEDIA").length;
  const audioCount = manifest.filter((r) => r.status === "ok" && r.uploadType !== "ONLINE_MEDIA").length;
  console.error(`\n===== Summary =====`);
  console.error(`targets: ${total}`);
  console.error(`ok: ${count("ok")}, skipped: ${count("skipped")}, error: ${count("error")}, dry: ${count("dry")}`);
  console.error(`  youtube.txt: ${youtubeCount}, audio downloaded: ${audioCount}`);
  if (errors.length) {
    console.error(`failures:`);
    for (const [id, msg] of errors) console.error(`  - ${id}: ${msg}`);
  }
}

main().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
