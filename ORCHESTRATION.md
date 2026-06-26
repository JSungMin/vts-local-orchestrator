# 오케스트레이션 가이드 — Claude + Ollama/Qwen + vts

세 행위자를 한 워크플로로 묶어 토큰을 아끼고 로컬·비공개로 코드 작업을 처리한다.

| 행위자 | 역할 | 비용 |
|---|---|---|
| **Claude** (Claude Code) | 오케스트레이터·추론기. 계획, 다단계 추론, 종합, 코드 작성/리뷰. | 유료(토큰) |
| **Qwen** (Ollama, 로컬 풀-GPU) | 로컬 워커. vts를 몰아붙여 `file:line` 로케이팅·대량 심볼 조사. | 무료·로컬 |
| **vts** (`vs-search`) | 공유 도구면. 양쪽이 같은 LSP 인덱스를 사용. | — |

핵심 아이디어: **싸고 양 많은 코드 위치찾기/조사**는 로컬 Qwen에게 위임 → Claude는 압축된
`file:line` 결과만 받아 추론에 집중. Claude 토큰은 검색 raw 출력에 쓰지 않는다.

```
        ┌─ Claude (계획·추론·종합·작성/리뷰) ─┐
        │   │ (1) vs-search MCP 직접 호출      │  ← Claude가 직접 빠른 단발 lookup
        │   │ (2) Bash: qvts "..."  ───────────┼──▶ Qwen(로컬) ──▶ vs-search ──▶ 코드
        │                                       │      (대량/반복 로케이팅, 무료)
        └───────────────────────────────────────┘
```

---

## 1. 언제 Claude가 Qwen에게 위임하나 (결정 규칙)

| 상황 | 처리 주체 | 이유 |
|---|---|---|
| 단발 "X 어디" 1~2건 | **Claude 직접** `vs-search` | 왕복 1회, 위임 오버헤드 > 이득 |
| 같은 종류 로케이팅 **다수**(N개 심볼/호출처 일괄) | **Qwen** `qvts` | N회 검색 raw가 Claude 컨텍스트를 안 먹음 |
| 모듈 전수 심볼 조사·맵핑 | **Qwen** | 출력 대량 → 로컬에서 소화, 요약만 반환 |
| 다단계 추론/설계/리뷰/수정 | **Claude** | 14B 로컬 모델은 다단계 약함 |
| 비공개 코드 외부전송 금지 강한 건 | **Qwen** | 완전 로컬, 무전송 |

규칙 요약: **"찾기/세기/나열"은 Qwen, "판단/설계/고치기"는 Claude.**

---

## 2. Claude가 위임하는 법 (CLI-first, 스키마 택스 0)

Claude는 Bash 도구로 한 줄 호출:

```bash
# 사람이 읽는 답
pwsh -File /path/to/qvts.ps1 "TakeDamage 호출하는 함수 전부 file:line"

# 기계 파싱용 JSON {task, answer, trace}
pwsh -File /path/to/qvts.ps1 -Json "UGameInstance 와 그 서브클래스 선언 위치"
```

`-Json` 이면 stdout에 `{"task","answer","trace":[{tool,args}...]}` — Claude가 `answer`만 취해
추론에 쓰고, `trace`로 Qwen이 뭘 호출했는지 감사 가능. 도구 호출 로그는 stderr로 빠져 stdout 오염 없음.

> 왜 MCP 아니고 CLI? MCP 도구는 항상 스키마가 컨텍스트에 상주(토큰 택스). 위임은 가끔 일어나므로
> CLI 한 줄이 더 싸다. (MCP로 묶고 싶으면 4장 참고 — 트레이드오프 명시)

---

## 3. 설정 — Claude가 이 위임을 "알게" 하기

이대로 두면 Claude는 qvts 존재를 모른다. 대상 프로젝트의 `CLAUDE.md`(또는 글로벌)에 아래 라우팅
블록을 넣어 Claude가 자동 판단하게 한다. → `claude-routing.md` 파일 내용을 복붙.

요지:
- "여러 심볼/호출처를 한꺼번에 찾을 땐 `qvts`로 로컬 Qwen에 위임."
- "단발 1건은 vs-search 직접."
- 결과는 file:line만 신뢰, 본문은 read_symbol로.

---

## 4. 대안: MCP 도구로 노출 (원하면)

Claude가 `ask_qwen(task)` 같은 네이티브 도구로 호출하길 원하면, 브리지를 감싼 작은 MCP 서버를
만들어 `.mcp.json`에 등록하면 된다. 장점: Claude가 자연스럽게 도구로 인식. 단점: 스키마 상주
토큰 택스(이 레포 메모리의 MCP-vs-CLI 원칙과 충돌). **권장: 기본 CLI, 빈번해지면 MCP 승격.**

필요하면 `qwen-orchestrator-mcp.mjs`(tool: `qwen_code_query`) 추가 가능 — 말만 하면 생성.

---

## 5. 예시 흐름 (Claude 세션)

> 유저: "데미지 파이프라인 정리하고 중복 계산 있으면 고쳐줘."

1. Claude: 광범위 다단계 → 직접 처리 결정. 먼저 **위치 수집을 Qwen에 위임**:
   `qvts -Json "TakeDamage, BeginPlay, GetController 선언/호출처 전부 file:line"`
2. Qwen → vs-search 연쇄 → 압축 file:line 목록 반환. (Claude 토큰 0으로 맵 확보)
3. Claude: 받은 file:line만 `read_symbol`로 핵심 본문 정독 → 중복 계산 추론.
4. Claude: 수정 작성 + `code-reviewer`로 검증. (판단·수정은 Claude)

검색 raw(수십 KB)는 Qwen이 소화, Claude는 결론만 → 토큰 절약 + 속도.

---

## 6. 한계

- Qwen 14B는 도구 인자를 가끔 틀림 → 브리지가 `projectPath` 자동 주입으로 보정. 그래도 모호한
  멀티홉 위임은 실패율 있음 → 위임은 "찾기형 단일 의도"로 좁게.
- clangd 콜드 인덱싱 첫 1회는 느림(증분·persisted db로 이후 빠름, prewarm은 브리지에서 끔).
- 동시에 Claude의 vs-search 세션과 Qwen 브리지가 각각 clangd를 띄우면 VRAM/CPU 경합 가능 →
  무거운 위임은 순차로.
