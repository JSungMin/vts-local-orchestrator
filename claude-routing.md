<!--
  DROP-IN: 이 블록을 대상 프로젝트의 CLAUDE.md(또는 ~/.claude/CLAUDE.md)에 붙여넣으면
  Claude가 로컬 Qwen 위임을 자동 판단한다. 경로는 환경에 맞게 수정.
-->

## 로컬 Qwen 위임 라우팅 (Claude + Ollama/Qwen + vts)

대량·반복적인 **코드 위치찾기/조사**는 Claude 토큰을 쓰지 말고 로컬 Qwen에게 위임한다.
Qwen은 vs-token-safer(`vs-search`) 도구를 몰아붙여 압축된 `file:line`만 돌려준다.

<delegation_rules>
- **Qwen에 위임** (Bash 한 줄):
  - 여러 심볼/타입/함수의 선언 위치를 **한꺼번에** 찾을 때
  - 한 심볼의 호출처/사용처가 **많을** 것으로 예상될 때
  - 모듈/디렉터리 **전수 심볼 조사·맵핑**
  - 비공개 코드라 외부전송을 피하고 싶을 때
  명령:
  `pwsh -File /path/to/qvts.ps1 -Json "<자연어 검색 작업>"`
  → stdout JSON `{task, answer, trace}`. `answer`의 file:line만 신뢰하고 본문은 `read_symbol`로.

- **Claude 직접** (`vs-search` MCP):
  - 단발 "X 어디" 1~2건 (위임 왕복이 더 비쌈)
  - 판단·설계·리뷰·수정 등 다단계 작업 (14B 로컬 모델은 다단계 약함)
</delegation_rules>

<delegation_protocol>
1. 위임 결과의 `file:line`은 사실로 신뢰하되, **선언 본문이 필요하면** 직접 `read_symbol`/`Read`로 확인.
2. Qwen이 빈 결과/오류를 주면(`answer`에 "nothing"/TOOL ERROR) 직접 `vs-search`로 재시도.
3. 수정·삭제 같은 쓰기 작업은 **Claude가** 수행(또는 명시적 apply 지시). 위임은 읽기 위주.
4. 무거운 위임은 순차 실행(Qwen·Claude 양쪽 clangd 동시 기동 시 자원 경합).
</delegation_protocol>

전제: `qvts.ps1` 가 동작하려면 setup 완료(모델 `qwen-coder-14b-vts` 풀-GPU 로드) +
`~/.vs-token-safer/config.json`의 `projectPath`가 대상 레포. 자세한 건 ORCHESTRATION.md / DEPLOY.md.
