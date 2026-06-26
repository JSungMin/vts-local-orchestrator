# 배포 가이드 (다른 머신 / 팀원 셋업)

이 브리지를 새 PC에 깔거나 팀원에게 배포할 때 절차. 핵심: **Ollama + Qwen 모델**, **Node 18+**,
**vs-token-safer 플러그인 경로 1곳**만 맞추면 동작.

---

## 1. 사전 조건

| 요소 | 요구 | 확인 |
|---|---|---|
| OS | Windows 10/11 (Linux/mac도 가능, 경로만 조정) | |
| GPU | NVIDIA, **VRAM ≥ 12GB** (14B 풀-GPU 32k 기준) | `nvidia-smi` |
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
2. **서버 환경변수**(User scope) 설정 — 14B-Q4 + 32k 가 16GB에 들어가게:
   - `OLLAMA_FLASH_ATTENTION=1`
   - `OLLAMA_KV_CACHE_TYPE=q8_0`  (32k KV ~6GB→~3GB)
   - `OLLAMA_KEEP_ALIVE=30m`, `OLLAMA_MAX_LOADED_MODELS=1`
3. 그 env가 먹도록 Ollama 서버 **재시작**
4. 베이스 `qwen2.5-coder:14b-instruct-q4_K_M` pull → `Modelfile.qwen-coder`로
   `qwen-coder-14b-vts` 빌드 (`num_ctx 32768`, `num_gpu 999`)

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
node qwen-mcp-bridge.mjs @args
```

---

## 4. VRAM 안 맞을 때 (GPU별 권장)

`Modelfile.qwen-coder` 의 `num_ctx` 조정 후 재빌드:
`ollama create qwen-coder-14b-vts -f Modelfile.qwen-coder`

| VRAM | 모델 | num_ctx | KV cache | 비고 |
|---|---|---|---|---|
| 16GB (RTX 5080) | 14B Q4_K_M | 32768 | q8_0 | 현재 구성, ~12GB 점유 |
| 12GB | 14B Q4_K_M | 16384 | q8_0 | 32k는 빡빡 → 16k 권장 |
| 12GB | 7B Q4_K_M | 32768 | q8_0 | 더 빠름, 추론 약간 약함 |
| 8GB | 7B Q4_K_M | 16384 | q8_0 | `qwen2.5-coder:7b` 로 베이스 교체 |
| 24GB+ | 14B Q5/Q6 | 32768 | fp16 | 품질↑, KV 양자화 불필요 |

베이스 모델 교체 시 `Modelfile.qwen-coder` 의 `FROM` 줄 변경.

CPU 오프로드 발생(`ollama ps` 에 `xx% CPU`) → 다른 GPU 프로세스 종료, 또는 위 표대로 축소.

---

## 5. 검증 (배포 후 필수)

```powershell
# (1) 모델 풀-GPU 확인
ollama run qwen-coder-14b-vts "hi"
ollama ps                       # PROCESSOR = 100% GPU

# (2) 브리지 ↔ MCP 핸드셰이크 + 도구 목록
node qwen-mcp-bridge.mjs "test"  # stderr에 'vs-search tools: ...' 15개 떠야 함

# (3) 실제 코드 질의 (clangd 콜드 인덱싱 한 번 기다림)
node qwen-mcp-bridge.mjs "아무 클래스나 선언 위치 찾아줘"
```

3단계가 `file:line` 반환하면 정상.

> 콜드 인덱싱 비용: 거대 UE 트리는 clangd 첫 인덱스가 수 분. vs-token-safer 데몬을 상주시켜
> 인덱스를 재사용하면 매번 안 기다림. (`vts_admin warmup` 또는 vs-token-safer serve 데몬)

---

## 6. 패키징 / 공유

같이 보낼 파일:

```
qwen-mcp-bridge.mjs      # 브리지 본체
Modelfile.qwen-coder     # 모델 정의
setup.ps1                # 프로비저닝
package.json             # SDK 의존성
USAGE.md  DEPLOY.md  README.md
```

받는 쪽: `npm install` → `setup.ps1` → 경로 3곳 맞춤(3장) → 검증(5장).
모델 weight(~9GB)는 각자 `ollama pull` (배포물에 안 넣음).

---

## 7. 제거

```powershell
ollama rm qwen-coder-14b-vts
ollama rm qwen2.5-coder:14b-instruct-q4_K_M
[Environment]::SetEnvironmentVariable("OLLAMA_FLASH_ATTENTION", $null, "User")
[Environment]::SetEnvironmentVariable("OLLAMA_KV_CACHE_TYPE",   $null, "User")
[Environment]::SetEnvironmentVariable("OLLAMA_KEEP_ALIVE",      $null, "User")
[Environment]::SetEnvironmentVariable("OLLAMA_MAX_LOADED_MODELS", $null, "User")
```
