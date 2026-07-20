# daglo-migration

[Daglo](https://daglo.ai) 계정 안의 보드(받아쓰기 결과)를 로컬 파일 시스템으로 내보내는 마이그레이션 스크립트.

보드를 **생성일자(KST) 기준** 날짜 트리로 정리하고, 각 보드의 받아쓰기 원본 JSON·텍스트 전문과 음원(또는 유튜브 다운로드 명령)을 함께 저장한다.

## 요구 사항

- **Node.js** (ESM 지원 버전)
- **daglo CLI** — PATH 에 `daglo` 명령이 있어야 함 (`daglo-mcp` 패키지)
  ```bash
  daglo --version        # 설치 확인
  daglo auth status      # 로그인 상태 확인 (안 돼 있으면 daglo auth login)
  ```
- (선택) 유튜브 원본을 실제로 받으려면 [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) — 각 `youtube.txt` 안의 명령을 실행할 때 필요

## 사용법

```bash
# 특정 폴더만 (folder ID 로 필터)
node migrate.mjs --folder 7eROsfeRyvxJeo1z

# 전체 보드 (folder ID 생략)
node migrate.mjs

# 실제 내보내기 없이 대상 경로만 미리보기
node migrate.mjs --folder 7eROsfeRyvxJeo1z --dry-run
```

> 폴더 ID 는 `daglo folder list --json` 으로 확인한다. (예: "설교" 폴더 = `7eROsfeRyvxJeo1z`)

### 옵션

| 옵션 | 설명 | 기본값 |
| --- | --- | --- |
| `--folder <id>` | 해당 폴더 보드만 처리. 생략 시 **전체 보드**. | 전체 |
| `--dry-run` | 실제 다운로드 없이 대상 경로만 출력. | off |
| `--force` | 이미 산출물이 있어도 다시 생성. | off |
| `--no-audio` | 음성 파일 다운로드 건너뜀 (용량 절약). 유튜브 `youtube.txt` 는 계속 생성. | off |
| `--concurrency <n>` | 보드 동시 처리 수. | 5 |

## 출력 구조

`output/<year>/<month>/<day>/<boardId>-<제목>/` (날짜는 **KST**, daglo 웹 UI 표시와 일치)

```
output/
├── manifest.json                     # 처리한 보드 인덱스
└── 2025/12/01/Fo0jOo4cYvssJSuM-251130 설교.m4a/
    ├── script.json                   # 받아쓰기 원본 JSON 응답 (raw)
    ├── transcript.txt                # 받아쓰기 텍스트 전문
    └── audio.m4a                      # 원본 음성 (FILE/RECORD 업로드)
└── 2024/01/22/do4mltNVWRNt-_6Y-오늘을 위한 레위기(4) _레위기와 희년_ (김근주 목사)/
    ├── script.json
    ├── transcript.txt
    └── youtube.txt                   # 원본 URL + yt-dlp 다운로드 명령 (유튜브 보드)
```

### 산출물 설명

- **`script.json`** — `daglo board script --json` 응답 그대로. `editorState` 안에 화자(speaker) 블록과
  karaoke 토큰별 단어·타임스탬프(`s`/`e`)까지 손실 없이 보존. 60분 초과 보드도 전체 구간 포함.
- **`transcript.txt`** — 받아쓰기 텍스트 전문.
- **음원 (보드 소스 유형별 분기)**
  - **유튜브(`ONLINE_MEDIA`)** → `youtube.txt`. 원본 URL 과 바로 실행 가능한 yt-dlp 명령(오디오 m4a / 영상 최고화질)을 담는다.
    ```
    # 오디오(m4a)만:
    yt-dlp -x --audio-format m4a -o "audio.%(ext)s" "<원본 URL>"
    # 영상 최고화질:
    yt-dlp -o "video.%(ext)s" "<원본 URL>"
    ```
  - **파일/녹음(`FILE`/`RECORD`)** → `audio.<ext>`. daglo 에 저장된 원본 음성을 직접 다운로드.
- **`manifest.json`** — `[{ boardId, name, createTime, folderId, uploadType, sourceUrl, path, status }]`.

## 동작 방식 / 특징

- **폴더 필터는 클라이언트 측 처리**: daglo API 의 `--folder` 서버 필터가 동작하지 않아, 전체 목록을 받아 `folderId` 로 직접 필터링한다.
- **대상 선별**: `status === COMPLETE` 이고 `fileMetaId` 가 있는 보드만 처리. 나머지는 사유와 함께 skip 로그.
- **재실행 안전(idempotent)**: 필요한 산출물이 모두 채워져 있으면 해당 보드는 skip. 중단 후 다시 실행하면 이어서 진행된다. (`--force` 로 무시 가능)
- **파일명 새니타이즈**: `\ / : * ? " < > |` 및 제어문자를 `_` 로 치환하고, 길이를 150자로 제한. 한글 등 유니코드는 유지.
- **전사 폴백**: 일부 보드(`version:1`, 종료시각 `e` 없는 karaoke 스키마)에서 CLI 의 텍스트 추출이 빈 결과를 낸다.
  이 경우 `script.json` 의 karaoke 토큰을 직접 이어붙여 `transcript.txt` 를 생성한다.
- **동시성 + 진행률**: 기본 5개 동시 처리, 각 보드 완료 시 `[i/total]` 로그 출력.

## 예시: 전체 마이그레이션

```bash
# 텍스트/JSON + 음원까지 (유튜브는 youtube.txt, 그 외는 오디오 다운로드)
node migrate.mjs

# 용량이 부담되면 오디오 없이
node migrate.mjs --no-audio
```

> ⚠️ 전체 모드에서 `FILE`/`RECORD` 보드는 보드당 평균 ~20MB 오디오를 받으므로 총 용량이 수 GB 가 될 수 있다.
> 유튜브 보드는 `youtube.txt` 만 생성하므로 용량 부담이 없다.

## 문제 해결 (Troubleshooting)

시작 시 `daglo auth status` 로 로그인 여부를 먼저 확인하며, daglo 명령 실패 시 CLI 의 실제 에러 메시지를 그대로 출력한다.

- **`'daglo' 명령을 찾을 수 없습니다`** — daglo CLI 가 설치돼 있고 PATH 에 있는지 확인한다. (`which daglo`)
- **`daglo 에 로그인돼 있지 않은 것 같습니다`** / **`Failed to fetch boards: Unauthorized`** — `daglo auth login` 으로 로그인한다.
- **`... 실패 (exit N): ...`** — 뒤에 붙는 메시지가 daglo CLI 가 실제로 보고한 원인이다. (예: `Not Found`, `Unauthorized`)
  같은 명령을 직접 실행해 재현·확인할 수 있다:
  ```bash
  daglo auth status
  daglo board list --page 1 --limit 500 --json
  ```

## 한계

- 다중 파일 보드(`attachedFileCount > 1`)는 대표 `fileMetaId` 하나만 내보낸다. (필요 시 `fileMeta[]` 순회 처리 추가 가능)
- `youtube.txt` 의 원본 URL 은 유효하지만, 업로더가 영상을 비공개/삭제한 경우 yt-dlp 다운로드가 실패할 수 있다.
