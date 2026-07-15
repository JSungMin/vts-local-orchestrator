# 사용 방법 (Qwen ↔ vs-token-safer 브리지)

로컬 **Qwen2.5-Coder-14B**(Ollama, 풀-GPU, 32k)가 `vs-token-safer`의 `vs-search` MCP 도구를
직접 호출해 UE C++ 코드베이스를 탐색/편집한다. Claude 토큰을 쓰지 않는 무료·로컬·비공개
코드 내비게이터.

---

## 0. 사전 조건 (한 번만)

```powershell
# Ollama 설치 + 풀-GPU 32k 환경 + 모델 pull/build
powershell -ExecutionPolicy Bypass -File .\setup.ps1
npm install          # MCP SDK 클라이언트 (node_modules 있으면 생략)
```

`setup.ps1` 완료 후 확인:

```powershell
ollama ps
# NAME                   PROCESSOR   CONTEXT
# gemma4-vts:latest      100% GPU    32768     ← 100% GPU 여야 함
```

`100% GPU` 아니면 → DEPLOY.md "VRAM 안 맞을 때" 참고.

---

## 1. 단발 질의

```powershell
node vts-bridge.mjs "UGameInstance 선언 위치 file:line?"
node vts-bridge.mjs "TakeDamage 호출하는 곳 전부 찾아줘"
node vts-bridge.mjs "코드에서 'BeginPlay' 문자열 쓰는 곳"
```

출력: Qwen이 도구를 연쇄 호출한 뒤(`stderr`에 `· 도구명(인자)` 로그), 마지막에 `file:line` 인용
포함한 짧은 답을 `stdout`으로.

## 1.5 웹 대시보드 (시각 확인)

Qwen이 실제로 도구를 호출하는지 라이브로 보려면:

```
dashboard.cmd            ← 더블클릭. 서버 띄우고 브라우저 자동 오픈 (http://127.0.0.1:7878)
dashboard.cmd -Project C:/path/to/your-project   ← 대상 레포 지정
dashboard.cmd -Port 8080 ← 포트 변경
```

화면: 작업 입력 → **모델 토큰 실시간 스트림** → 🔧 도구콜(인자) → ✅ 결과(file:line) → 🟢 최종답.
우측 패널: step·tool calls·tok/s·elapsed + `ollama ps` GPU 상태(4초 갱신).

끄기: 창 닫기, 또는 `powershell -File stop-dashboard.ps1`.
완전 로컬(127.0.0.1, 무전송), 외부 의존성 0.

## 2. REPL (연속 대화)

```powershell
node vts-bridge.mjs
qvts> ACharacter 클래스 멤버 함수 목록
qvts> 그 중 BeginPlay 본문 보여줘
qvts> exit
```

대화 히스토리 유지됨 → 후속 질문 가능.

---

## 3. 질의 잘 쓰는 법

14B 로컬 모델은 Claude보다 다단계 추론 약함. **구체적 단일 의도**가 정확도 높음.

| 좋은 질의 | 매핑되는 도구 |
|---|---|
| "X 선언 어디" | `search_symbol` / `goto_definition` |
| "Y 호출하는 곳 / 사용처" | `find_references` |
| "Z 본문 보여줘" | `read_symbol` |
| "이 파일 클래스/함수 목록" | `document_symbols` |
| "문자열/주석/설정키 grep" | `search_text` |
| "이름이 W인 파일 찾아" | `find_files` |
| "에러/경고" | `diagnostics` |

피해야 할 질의: "이 모듈 전체 리팩터링", "버그 다 찾아" 같은 광범위·다단계 작업 → Claude/실제
리뷰어 몫. 브리지는 **로케이터**로 쓸 것.

---

## 4. 편집 도구 (주의)

`replace_symbol_body`, `insert_symbol`, `rename`, `safe_delete` 도 노출됨. **기본 preview**
(쓰기 안 함). 실제 적용은 인자 `apply=true` 일 때만. Qwen에게 편집 시키려면 명시적으로
"적용해(apply)"라고 지시. Perforce read-only 파일은 apply 시 자동 `p4 edit`.

---

## 5. 환경 변수 오버라이드

| 변수 | 기본값 | 용도 |
|---|---|---|
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama 주소 |
| `QVTS_MODEL` | `gemma4-vts` | 사용 모델 (벤치마크상 최적 — 바꾸기 전 README 표 확인) |
| `VTS_PROJECT` | config.json 의 projectPath | 대상 레포 변경 |
| `VTS_SERVER` | `…/vs-token-safer/server/index.js` | MCP 서버 경로 |
| `QVTS_MAXSTEPS` | `25` | 도구 호출 라운드 상한 |
| `QVTS_NUM_CTX` | `32768` | 컨텍스트 길이 |

다른 레포 대상:

```powershell
$env:VTS_PROJECT = "G:/path/to/other/repo"
node vts-bridge.mjs "메인 진입점 어디?"
```

---

## 6. 트러블슈팅

| 증상 | 원인 / 조치 |
|---|---|
| 첫 질의가 수 분 멈춤 | clangd 콜드 인덱싱(거대 UE 트리). 한 번만 느림. 미리 `vts_admin warmup` 또는 vs-token-safer 데몬 상주 시 재사용 |
| `Ollama 500` / 응답 없음 | `ollama ps` 로 모델 로드 확인. 안 뜨면 `setup.ps1` 재실행 |
| `100% GPU` 아님(CPU 오프로드) | VRAM 부족. 다른 GPU 프로세스 종료 or 해당 `Modelfile.*` 의 `num_ctx` 낮춰 재빌드 |
| 도구가 빈 결과 | 심볼 오타 / clangd 인덱스 미완. 콜드 인덱싱 끝났는지 확인 |
| `projectPath` 가 cwd로 감 | `~/.vs-token-safer/config.json` 의 `projectPath` 확인 or `VTS_PROJECT` 지정 |

---

## 7. 동작 구조 (요약)

```
당신 ──질의──▶ vts-bridge.mjs ──/api/chat+tools──▶ Ollama(Qwen, GPU)
                    │  ▲                                   │ tool_calls
                    │  └────── 도구 결과 ◀──────────────────┘
                    ▼ MCP stdio (callTool)
            vs-search 서버 (clangd 인덱스) ──▶ your C++ code
```

- `vs-token-safer`: 모델 미탑재·무전송 코드검색 surface(원래 Claude Code 전용).
- 브리지: 별도 MCP 호스트로 Qwen을 그 도구들에 연결. 결과는 토큰캡 `file:line`.
