# 배포 가이드 (다른 머신 / 팀원 셋업)

이 브리지를 새 PC에 깔거나 팀원에게 배포할 때 절차. 핵심: **Ollama + gemma4 모델**, **Node 18+**,
**vs-token-safer 플러그인 경로 1곳**만 맞추면 동작.

> **기본 모델은 `gemma4-vts` (`gemma4:e4b`)** — README의 벤치마크에서 "X 어디 선언됐어" 8/8, 7–12초로
> 가장 정확하고 빠릅니다. qwen 변종은 **선택 사항**(무겁고 느림)이며, 코드 특화 qwen2.5-coder **7B는
> 심볼 선언 검색을 재현성 있게 실패(0/6)** 하므로 기본으로 쓰지 마세요. `setup.ps1`은 인자 없이 실행하면
> gemma4를 빌드합니다. 아래 문서는 gemma4 기준이고, qwen 경로는 그때만 표시합니다.

---

## 1. 사전 조건

| 요소 | 요구 | 확인 |
|---|---|---|
| OS | Windows 10/11 (Linux/mac도 가능, 경로만 조정) | |
| GPU | NVIDIA, **VRAM ≥ 12GB** (기본 gemma4 ~9.6GB 풀-GPU 기준; qwen 14B는 ~11GB로 빠듯) | `nvidia-smi` |
| Node | 18+ (권장 20/22/24) | `node --version` |
| Ollama | 최신 | `ollama --version` |
| vs-token-safer | 설치돼 있고 `server/index.js` 존재 | |

VRAM 12GB 미만이면 → "VRAM 안 맞을 때" 표 참고(모델/컨텍스트 축소).

---

## 2. 설치 절차

```powershell
# (a) Ollama 설치 (없으면)
winget install Ollama.Ollama

# (b) 이 폴더에서
npm install

# (c) 풀-GPU 환경 + 모델 pull/build
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

`setup.ps1` 이 하는 일:
1. `ollama.exe` 위치 탐색
2. **서버 환경변수**(User scope) 설정 — 모델 + 32k 컨텍스트가 16GB에 들어가게:
   - `OLLAMA_FLASH_ATTENTION=1`
   - `OLLAMA_KV_CACHE_TYPE=q8_0`  (32k KV ~6GB→~3GB)
   - `OLLAMA_KEEP_ALIVE=30m`, `OLLAMA_MAX_LOADED_MODELS=1`
3. 그 env가 먹도록 Ollama 서버 **재시작**
4. 베이스 `gemma4:e4b` pull → `Modelfile.gemma4`로 `gemma4-vts` 빌드 (`num_gpu 999`)
   — `-Model qwen14b` / `-Model qwen3` 을 주면 각각 `qwen-coder-14b-vts` / `qwen3-vts` 를 대신 빌드

---

## 3. 머신별 경로 맞추기 (중요)

브리지/설정에 **하드코딩된 경로 3곳**. 새 머신에서 다르면 환경변수로 덮거나 파일 수정.

| 항목 | 기본값(이 머신) | 변경 방법 |
|---|---|---|
| vs-search 서버 | `<vs-token-safer>/server/index.js` (자동 탐지) | `VTS_SERVER` env 또는 `qvts.config.json` 의 `vtsServer` |
| 대상 레포 | `~/.vs-token-safer/config.json` 의 `projectPath` | `VTS_PROJECT` env 또는 config.json 수정 |
| clangd | config.json `clangdCmd` | vs-token-safer 의 `vts setup` |

팀 배포 시 권장: 경로를 env로 빼서 `.env`/실행 래퍼로 주입(파일 직접 수정 금지 → 충돌 방지).

```powershell
# 예: 래퍼 run.ps1
$env:VTS_SERVER  = "D:/tools/vs-token-safer/server/index.js"
$env:VTS_PROJECT = "D:/work/MyGame"
node vts-bridge.mjs @args
```

---

## 4. VRAM 안 맞을 때 (GPU별 권장)

해당 `Modelfile.*` 의 `num_ctx` 조정 후 재빌드:
`ollama create <tag> -f Modelfile.<변종>` (예: `ollama create gemma4-vts -f Modelfile.gemma4`)

| VRAM | 모델 | num_ctx | KV cache | 비고 |
|---|---|---|---|---|
| **12GB+** | **gemma4:e4b** *(기본)* | 32768 | q8_0 | **권장** — ~9.6GB, 가장 정확하고 빠름 |
| 16GB (RTX 5080) | qwen 14B Q4_K_M | 32768 | q8_0 | ~12GB 점유. 정확하나 느림(9–43초) |
| 12GB | qwen 14B Q4_K_M | 16384 | q8_0 | 32k는 빡빡 → 16k 권장 |
| 8GB | qwen 7B Q4_K_M | 16384 | q8_0 | ⚠️ 심볼 선언 검색 실패(0/6) — 최후 수단 |
| 24GB+ | qwen 14B Q5/Q6 | 32768 | fp16 | 품질↑, KV 양자화 불필요 |

VRAM이 gemma4를 감당하면 **모델을 바꾸지 마세요** — qwen 쪽은 전부 느리거나(14B) 핵심 기능이
깨집니다(7B). 베이스 모델 교체 시 해당 `Modelfile.*` 의 `FROM` 줄 변경.

CPU 오프로드 발생(`ollama ps` 에 `xx% CPU`) → 다른 GPU 프로세스 종료, 또는 위 표대로 축소.

---

## 5. 검증 (배포 후 필수)

```powershell
# (1) 모델 풀-GPU 확인
ollama run gemma4-vts "hi"
ollama ps                       # PROCESSOR = 100% GPU

# (2) 브리지 ↔ MCP 핸드셰이크 + 도구 목록
node vts-bridge.mjs "test"  # stderr에 'vs-search tools: ...' 15개 떠야 함

# (3) 실제 코드 질의 (clangd 콜드 인덱싱 한 번 기다림)
node vts-bridge.mjs "아무 클래스나 선언 위치 찾아줘"
```

3단계가 `file:line` 반환하면 정상.

> 콜드 인덱싱 비용: 거대 UE 트리는 clangd 첫 인덱스가 수 분. vs-token-safer 데몬을 상주시켜
> 인덱스를 재사용하면 매번 안 기다림. (`vts_admin warmup` 또는 vs-token-safer serve 데몬)

---

## 6. 패키징 / 공유

같이 보낼 파일:

```
vts-bridge.mjs      # 브리지 본체
Modelfile.gemma4         # 기본 모델 정의 (qwen 쓸 때만 Modelfile.qwen25-14b / Modelfile.qwen3 추가)
setup.ps1                # 프로비저닝
package.json             # SDK 의존성
USAGE.md  DEPLOY.md  README.md
```

받는 쪽: `npm install` → `setup.ps1` → 경로 3곳 맞춤(3장) → 검증(5장).
모델 weight(~9GB)는 각자 `ollama pull` (배포물에 안 넣음).

---

## 7. 제거

```powershell
ollama rm gemma4-vts
ollama rm gemma4:e4b
# qwen 변종을 빌드했다면: ollama rm qwen-coder-14b-vts qwen2.5-coder:14b-instruct-q4_K_M
[Environment]::SetEnvironmentVariable("OLLAMA_FLASH_ATTENTION", $null, "User")
[Environment]::SetEnvironmentVariable("OLLAMA_KV_CACHE_TYPE",   $null, "User")
[Environment]::SetEnvironmentVariable("OLLAMA_KEEP_ALIVE",      $null, "User")
[Environment]::SetEnvironmentVariable("OLLAMA_MAX_LOADED_MODELS", $null, "User")
```
