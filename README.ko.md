# vts-local-orchestrator

[English](README.md) | **한국어**

**Claude는 코드를 읽고 검색하는 데 비싼 토큰을 씁니다. 그 단순 작업을 무료 로컬 모델에 넘기고, Claude는
한 줄짜리 답만 받습니다.**

<p align="center">
  <img src="docs/how-it-works.svg" alt="Claude가 대량 코드 검색·파일 읽기를 무료 로컬 모델(Ollama의 gemma4)에 위임하고, 압축된 답만 돌려받아 토큰을 일부만 씁니다." width="900">
</p>

[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-7C3AED)](https://code.claude.com/docs/en/plugins)
[![Ollama](https://img.shields.io/badge/Ollama-local%20LLM-000000)](https://ollama.com)
[![Local only](https://img.shields.io/badge/local--only-nothing%20uploaded-success)](#안전한가요)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**[vs-token-safer](https://github.com/JSungMin/vs-token-safer)**의 짝꿍 도구입니다. 전부 내 컴퓨터에서만
돌아가고, 아무것도 외부로 나가지 않습니다.

## 한 줄 요약

코드 찾기 — "이 함수 20개 어디 있어", "X 부르는 곳", "이 파일 뭐 하는 거야" — 는 양은 많지만 머리 쓸 일은
적은 작업입니다. **무료 로컬 모델**이 충분히 할 수 있죠. 그래서 맡깁니다: Claude가 묻고, 로컬 모델이
검색·읽기를 하고, Claude는 짧은 답만 받습니다. 덩치 큰 원본 출력은 Claude 컨텍스트에 들어오지 않습니다.

**기준: "찾기 / 세기 / 읽기" → 로컬 모델. "판단 / 설계 / 수정" → Claude.**

명령어를 칠 필요가 없습니다. 늘 하던 대로 Claude에게 물어보면 됩니다 — 플러그인이 설치돼 있으면 Claude가
조용히 검색을 로컬 모델에 넘기고 답만 보여줍니다:

```text
나       ▸  loadConfig 선언 위치랑 그걸 부르는 곳 전부 알려줘

Claude   ▸  (내 GPU의 로컬 모델에 검색을 넘김 — 원본 출력은 나한테 안 들어옴)
            config-loader.mjs:40       ← 여기 선언
            agent-core.mjs:14,16       ← 호출
            vts-bridge.mjs:29,31       ← 호출

            검색은 로컬 모델이 했고, 나는 답 읽는 데 약 20토큰만 썼습니다.
```

읽기도 마찬가지: *"`tsbridge.py` 뭐 하는 거야 — 출력 많이 뱉는 핸들러 있어?"* → Claude가 로컬 모델에 파일을
읽혀서 몇 줄로 보고합니다. 파일 전체를 대화에 끌어오지 않고요.

> 위임 시점은 Claude가 알아서 정합니다 — 명령어를 칠 일이 없습니다. 직접 다루고 싶다면? 밑에 `qvts` CLI가
> 있습니다 — [빠른 시작](#빠른-시작) 참고.

## 왜 쓰나요

- **저렴합니다.** 로컬 모델은 무료고 내 GPU에서 돕니다. Claude는 최종 요약값만 토큰을 씁니다.
- **안전합니다.** 모델도 검색 도구도 `127.0.0.1`에서만 돕니다. 코드가 컴퓨터 밖으로 나가지 않습니다.
- **아무 모델이나 됩니다.** 기본값은 `gemma4:e4b`(이름이 아니라 [벤치마크](#어떤-모델)로 고름) — 설정 한 줄로 교체.

## 빠른 시작

[Ollama](https://ollama.com), **Node 18+**, 그리고 이 저장소 옆에
[vs-token-safer](https://github.com/JSungMin/vs-token-safer) 사본이 필요합니다.

```bash
git clone <이-저장소-url> vts-local-orchestrator && cd vts-local-orchestrator
npm install
bash setup-macos.sh          # macOS/Linux — RAM에 맞는 모델 선택·빌드, 설정 파일 생성
#  Windows: setup.ps1  (DEPLOY.md 참고)
```

그다음 Claude Code 플러그인으로 설치하세요(또는 [`claude-routing.md`](claude-routing.md) 내용을
`CLAUDE.md`에 붙여넣기). **끝입니다** — 이제 Claude에게 평범하게 물어보면 검색·큰 읽기를 알아서 넘깁니다.

실시간으로 보고 싶다면? `node dashboard.mjs` → http://127.0.0.1:7878.

<details>
<summary>직접 다루기 (내부의 <code>qvts</code> CLI)</summary>

보통 건드릴 일 없습니다 — Claude가 대신 부릅니다 — 하지만 원하면 평범한 CLI입니다:

```bash
qvts -p /경로/repo "createSession 부르는 곳 전부 찾아줘"      # 평범한 말로 물어보기
qvts digest ./큰-파일.md --focus "이거 뭐 하는 거야?"         # 파일을 대신 읽혀서 요약받기
qvts --savings                                              # 지금까지 아낀 토큰
```
</details>

## 무엇을 할 수 있나요

그냥 Claude에게 평범한 말로 물어보면 — 아래 전부 로컬 모델로 위임됩니다:

**코드 찾기** — `file:line`을 받음:
- *"`loadConfig` 어디 선언됐어?"* · *"`createSession` 부르는 곳?"* · *"`*.test.ts` 파일 다 찾아줘"*
- *"X, Y, Z 이거 다 어디 정의됐어?"* — 여러 개를 한 번에.

**코드 읽기** — 소스 더미가 아니라 짧은 요약을 받음:
- *"`tsbridge.py` 뭐 하는 거야?"* · *"`auth` 폴더 요약해줘"*
- *"내 diff에서 뭐가 바뀌었고 어떤 파일을 봐야 해?"*

**동작 보기:**
- *"대시보드 열어줘"* — 모델이 무슨 일을 하는지 프로젝트·작업종류별로 묶어 실시간으로 보여주고, 아낀
  토큰도 표시하는 로컬 페이지.

같은 질문은 즉시·무료(캐시)고, 모든 위임은 절약 합계에 누적됩니다.

## 어떤 모델

도구 호출이 되는 Ollama 모델이면 다 됩니다. 기본값 **`gemma4:e4b`**는 명성이 아니라 — 16GB 기기에서 코드
찾기를 한 번에 가장 정확히, 그리고 정확한 모델 중 가장 빠르게 해냈기 때문에 골랐습니다.

<details>
<summary>벤치마크 (재현·모델 교체 방법)</summary>

**16GB Apple M4**에서, 후보마다 실제 `qvts` 브리지로 정답이 있는 검색 작업을 세 저장소에 걸쳐 돌려, 정확도·
안정성·속도(웜)·100% GPU 유지 여부로 채점했습니다.

| 모델 (튜닝 `-vts`) | 크기 | "X 어디 선언됐어" | 그 외 검색 | 속도(웜) | GPU / 메모리 | 결론 |
| --- | --- | --- | --- | --- | --- | --- |
| **gemma4:e4b** *(기본)* | 8 B | ✅ **8/8**, 각 1콜 | ✅ | **7–12초** | 100% GPU · ~9.6 GB | **최적 균형** |
| qwen2.5-coder 14B | 14 B | ✅ 4/4 | ✅ | 느림 9–43초 | 100% GPU · ~11 GB (빠듯) | 정확하나 느리고 무거움 |
| qwen3:8b | 8 B | ✅ `think` 켜야만 | ✅ | 매우 느림 23–89초 | 100% GPU · ~6.6 GB | 속도↔정확도 균형 나쁨 |
| qwen2.5-coder 7B | 7.6 B | ❌ **0/6** (무한루프) | ✅ 파일/참조 | 빠름 2–3초 | 100% GPU · ~5.8 GB | 핵심 검색 기능 실패 |
| gemma3:12b | 12 B | — | — | — | — | **도구 호출 불가 — 탈락** |

코드 특화 qwen2.5-coder 7B(처음엔 당연해 보이는 선택)는 "X 어디 선언됐어"를 반복적으로 *실패*합니다 —
엉뚱한 도구를 골라 무한루프에 빠져요. 그래서 기본값으로는 위험합니다. qwen을 키우면 정확해지지만 16GB에선
느리고 메모리가 빠듯합니다.

**모델 교체:** 튜닝 변형을 빌드하고 설정이 그걸 가리키게 합니다.
```bash
ollama create my-vts -f Modelfile.my       # FROM <base> + temperature 0.15 + num_gpu 999
# qvts.config.json 에서 "model": "my-vts"  (또는 export QVTS_MODEL=my-vts)
```
`ollama show <모델>`에 `tools`가 있어야 합니다.
</details>

## 얼마나 아끼나요

실행마다 대시보드가 Claude가 *썼을* 양을 세 방식으로 보여줍니다:

| 방식 | 대략 |
| --- | --- |
| Claude가 직접 grep / 원본 읽기 | ~100% (기준) |
| Claude가 검색 도구를 직접 실행 | ~30–50% |
| **로컬 모델에 위임 (이 도구)** | **~6–20%** |

추정치(`≈ 글자수/4`)이고, 기준값은 추가 비용이 아니라 *아낀* 양입니다.

## 어떻게 동작하나요 (요약)

`vs-token-safer`는 Claude Code용 코드 검색 도구지만, Claude는 그걸 *다른* 모델로 돌릴 수 없습니다. 이
도구가 그 틈을 메웁니다: 검색 서버를 띄우고, 그 도구들을 내 로컬 Ollama 모델에 넘겨주고, 모델이 검색
반복을 스스로 돌리게 한 뒤 — Claude에는 답만 돌려줍니다.

로컬 모델은 **읽기 전용 검색 도구**만 받습니다. 수정은 전부 Claude가 합니다. 브리지는 작은 모델 뒤처리도
해줍니다(빠뜨린 저장소 경로 채우기, 텍스트로 샌 도구 호출 복구, 오타로 인한 무한루프 차단).

<details>
<summary>전체 레퍼런스 — 모든 명령·플래그·설정</summary>

**명령:** `qvts "<검색>"` · `digest <파일>` · `digest-dir <폴더>` · `web <url>` · `triage-diff` ·
`daemon start|stop|status` · `--savings`
**플래그:** `--json` · `-p/--project <repo>` · `--no-cache` · `--no-daemon` · `--batch <json|file|->` ·
`--focus "..."` · `--staged`

설정 우선순위(낮음→높음): 내장 기본값 < `qvts.config.json` < `VTS_*`/`QVTS_*` 환경변수.

| 설정 키 | 환경변수 | 기본값 | 의미 |
| --- | --- | --- | --- |
| `model` | `QVTS_MODEL` | `gemma4-vts` | 구동할 Ollama 모델 (`tools` 필요). |
| `numCtx` | `QVTS_NUM_CTX` | `16384` | 컨텍스트 창. |
| `maxSteps` | `QVTS_MAXSTEPS` | `25` | 포기 전 도구 호출 횟수. |
| `vtsServer` | `VTS_SERVER` | 자동 | `vs-token-safer/server/index.js` 경로. |
| `project` | `VTS_PROJECT` | vs-token-safer에서 | 대상 저장소 (호출마다 `-p`로 변경). |
| `port` | `PORT` | `7878` | 대시보드 포트. |
| — | `QVTS_THINK` | 미설정 | `0` = 빠른 구동 · `1` = 켬 · 미설정 = 모델 기본. |
| — | `QVTS_AUTO_NARROW` | `soft` | 인덱스 없는 C/C++ 트리: `soft` 빠른실패 · `hard` 제거 · `off`. |
| — | `QVTS_DEF_SEARCH` | 켬 | `0`이면 언어별 선언 탐색기 끔. |
| — | `VTS_AUTO_DAEMON` | 끔 | `1` = 세션 저장소용 웜 데몬 자동 시작. |
| — | `VTS_AUTO_DISTILL` | 끔 | 큰 `Read`를 `qvts digest`로 유도: `warn` · `block` · 끔. |
| — | `QVTS_ACTIVITY_LOG` | 켬 | `0`이면 대시보드 활동 로그 끔. |
| — | `QVTS_CACHE_TTL` | `3600` | 비-git 대상 캐시 수명(초). |
| — | `QVTS_KEEP_ALIVE` | `30m` | Ollama가 모델을 메모리에 유지하는 시간. |
| `ollamaHost` | `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama 주소. |

더 보기: `USAGE.md` · `DEPLOY.md` · `ORCHESTRATION.md` · `claude-routing.md`.
</details>

<details>
<summary>안 될 때</summary>

| 증상 | 해결 |
| --- | --- |
| 첫 질문이 ~90초 걸림 | 모델 콜드 로딩(1회성). 이후 `keep_alive`로 웜 유지. |
| `ollama ps`에 CPU 분산 표시 | 모델이 VRAM보다 큼 — 더 작은 모델 쓰거나 `num_gpu 999`로 재빌드. 16GB면 7–8B 권장. |
| `could not resolve @modelcontextprotocol/sdk` | `npm install` 실행(플러그인은 첫 실행 시 자가 복구, 또는 `/qvts-deps`). |
| 분명 있는 심볼인데 "no match" | 작은 모델이 엉뚱한 도구 선택 — 재시도하거나 Claude가 직접 검색. |
| 엉뚱한 저장소 검색 | 항상 `-p <repo-root>` 넘기기. |
</details>

## 안전한가요

네 — 전부 로컬입니다. Ollama, 검색 서버, 대시보드 모두 `127.0.0.1`에 바인딩되고 아무것도 업로드하지
않습니다. 외부로 나가는 동작은 첫 실행의 `npm install` 하나뿐입니다. 로컬 모델은 코드를 *읽기*만 할 수
있고, 수정은 전부 Claude를 거칩니다. (`qvts web <url>`은 예외 — 지정한 페이지를 가져옵니다.)

## 관련 프로젝트

- **[vs-token-safer](https://github.com/JSungMin/vs-token-safer)** — 이 도구가 구동하는 코드 검색 레이어. 필수.

## 라이선스

MIT © 2026 JSungMin
