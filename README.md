# claude-design-mcp

omo 채팅에서 [Claude Design](https://claude.ai/artifacts/design)(claude.ai의 Design 아티팩트)에 시안을 요청하고, 결과 미리보기와 소스 파일을 프로젝트로 받아오는 개인용 MCP 서버입니다. claude.ai에 직접 들어가지 않아도 "시안 요청 → 미리보기 확인 → 수정 요청 → 소스 받아서 구현"까지 omo 안에서 이어집니다. omonitor 세션에서도 똑같이 쓸 수 있습니다.

> **먼저 알아두세요.** 공식 API가 아니라 본인 계정으로 로그인한 전용 Chrome을 조작해서 claude.ai 화면과 내부 API를 쓰는 방식입니다. claude.ai가 바뀌면 동작이 깨질 수 있습니다. 탐지 우회(UA 위장 등), 여러 계정 돌려쓰기, 권한 요청 자동 승인은 넣지 않았습니다. 쓰기 전에 본인 요금제 약관과 조직 정책을 확인하세요. 생성과 수정은 본인 Claude 사용량에서 차감됩니다.

## 할 수 있는 것

- 말로 시안 요청: Claude Design이 직접 디자인을 만듭니다.
- 완료 대기와 미리보기: 끝나면 PNG 미리보기가 omo/omonitor 대화에 바로 보입니다.
- 소스 자동 저장: 끝나면 `.dc.html` 등 실제 파일이 `<프로젝트>/claude-design/…`에 저장됩니다.
- 말로 수정 요청: 같은 디자인 채팅에 이어서 요청합니다.
- 요소를 클릭해서 주석으로 수정 요청: Mac 화면에 디자인을 띄워 요소마다 주석을 달고 한 번에 보냅니다.

## 동작 방식

```
omo / omonitor 세션 ──stdio──▶ src/mcp.ts (MCP 서버)
                                  │ Unix socket (~/.claude-design-mcp/daemon.sock, 권한 0600)
                                  ▼
                              src/daemon.ts (하나만 실행, 요청을 순서대로 처리)
                                  │ playwright-core (pipe 연결, TCP 디버깅 포트 없음)
                                  ▼
                       전용 Chrome 프로필 ──▶ claude.ai Claude Design
```

- 데몬은 첫 tool 호출 때 자동으로 뜨고, 30분 동안 요청이 없으면 스스로 종료합니다. 여러 세션이 데몬 하나를 함께 씁니다.
- 전용 Chrome은 **화면에 보이는 일반 창**으로 뜹니다. headless Chrome은 claude.ai의 Cloudflare 확인 화면에서 막히기 때문입니다. 5분 동안 요청이 없으면 이 창은 자동으로 닫히고, 다음 호출 때 다시 뜹니다.
- 미리보기는 claude.ai 화면을 찍는 게 아니라, 디자인 파일을 내려받아 로컬에서 렌더링한 결과입니다.

## 요구 사항

- macOS. Chrome 경로, 키체인, `open` 명령을 macOS 기준으로 씁니다. 다른 OS는 확인하지 않았습니다.
- [Bun](https://bun.sh) 1.4 이상 (1.4.2에서 확인)
- Google Chrome (`/Applications/Google Chrome.app`). 다른 위치에 있으면 `CLAUDE_DESIGN_CHROME`으로 지정합니다.
- Claude Design을 쓸 수 있는 claude.ai 계정 (Pro, Max, Team, Enterprise). 조직 설정에서 Artifacts와 Design 템플릿이 켜져 있어야 합니다.
- [omo](https://github.com/code-yeongyu/oh-my-openagent). omonitor는 선택입니다.

## 설치

```sh
git clone https://github.com/jcwleo/claude-artifacts-mcp.git
cd claude-artifacts-mcp
bun install
```

`playwright-core`는 브라우저를 따로 내려받지 않고, 설치된 Google Chrome을 그대로 씁니다.

### omo에 등록

omo 전역 MCP 설정 `~/.omo/agent/mcp.json`에 아래 항목을 추가합니다. 파일이 없으면 새로 만들고, 이미 다른 서버가 있으면 `mcpServers` 안에 `claude-design` 항목만 넣으면 됩니다.

```json
{
  "mcpServers": {
    "claude-design": {
      "command": "/Users/<사용자>/.bun/bin/bun",
      "args": ["/절대/경로/claude-artifacts-mcp/src/mcp.ts"],
      "requestTimeoutMs": 900000
    }
  }
}
```

- `command`: `which bun`으로 나온 절대 경로를 넣습니다.
- `args`: clone한 위치의 `src/mcp.ts` 절대 경로를 넣습니다.
- `requestTimeoutMs`: omo는 tool 호출 하나를 기본 30초에 끊습니다. 디자인 생성은 몇 분 걸리므로 15분(900000)으로 늘려야 합니다.
- 환경 변수(아래 [설정](#설정))를 바꾸려면 같은 항목에 `"env": { "CLAUDE_DESIGN_WAIT_SEC": "300" }`처럼 넣습니다. omo는 MCP 서버에 `HOME`, `PATH` 같은 일부 변수만 넘기기 때문입니다.

등록되었는지는 omo에서 `/mcp status`로 보거나, "claude-design의 design_status 불러줘"라고 요청해서 확인합니다.

다른 MCP 클라이언트도 stdio 서버로 같은 명령(`bun <경로>/src/mcp.ts`)을 등록하면 되지만, omo와 omonitor에서만 확인했습니다. 어떤 클라이언트든 tool 호출 타임아웃을 15분 정도로 늘려야 합니다.

## 처음 한 번: 로그인

1. omo에서 "claude design 로그인 창 띄워줘"라고 요청합니다. 에이전트가 `design_login`을 부르면 claude.ai 로그인 페이지가 열린 Chrome 창이 뜹니다. 평소 쓰는 Chrome과는 다른 전용 프로필(`~/.claude-design-mcp/chrome-profile`)이라 평소 Chrome에는 영향이 없습니다.
2. 그 창에서 claude.ai에 로그인합니다.
3. 로그인이 끝나면 **그 창을 앞에 둔 채 Cmd+Q로 Chrome을 종료**합니다. 창만 닫으면 macOS에서 Chrome 프로세스가 남아 있어 데몬이 프로필을 쓸 수 없습니다.
4. "design_status 확인해줘"라고 요청해서 `loggedIn: true`가 나오면 끝입니다.

로그인은 전용 프로필에 저장되어 데몬이나 Chrome이 다시 떠도 유지됩니다. claude.ai에서 로그아웃되면 같은 과정을 한 번 더 하면 됩니다.

## 사용 방법

모든 기능은 omo(또는 omonitor) 채팅에서 말로 요청하면 에이전트가 알맞은 tool을 부릅니다. 아래 예시처럼 요청하면 됩니다.

### 1. 시안 만들기

> 개인 독서 기록 대시보드 시안 만들어줘. 헤더, 통계 카드 3개, 주간 독서 시간 막대 차트, 읽는 중인 책 목록이 있으면 좋겠어.

`design_create`가 claude.ai에 새 Design을 만들고 요청을 보냅니다. 보통 1분에서 몇 분 걸리고, 끝나면 다음이 한꺼번에 돌아옵니다.

- 상태(`done`)와 Claude Design의 답변
- 미리보기 이미지 (omo/omonitor 대화에 바로 표시)
- 소스 저장 위치: `<프로젝트>/claude-design/<디자인이름>-<id 앞 8자리>/`
- claude.ai에서 직접 열 수 있는 `url`

기본으로 4분(240초)까지 기다리고, 그 안에 안 끝나면 `generating` 상태로 먼저 돌아옵니다. 그때는 "계속 기다려줘"라고 하면 `design_wait`로 이어서 기다립니다.

### 2. 말로 수정하기

> Shelf 디자인에서 통계 카드 모서리를 더 둥글게, 강조색은 짙은 파랑으로 바꿔줘.

`design_reply`가 같은 디자인 채팅에 이어서 요청하고, 끝나면 미리보기와 갱신된 소스를 돌려줍니다. 디자인 ID를 기억할 필요는 없습니다. 에이전트가 `design_list`로 찾습니다. Claude Design이 아직 작업 중이면 거절되니, 그때는 먼저 기다리라고 하면 됩니다.

### 3. 요소를 클릭해서 주석으로 수정하기 (데스크톱 전용)

> Shelf 디자인에 주석 달 수 있게 띄워줘.

1. 전용 Chrome 창에 디자인이 새 탭으로 열립니다. 앞으로 나오지 않으면 Dock에 있는 두 번째 Chrome 아이콘을 누르세요.
2. 요소에 마우스를 올리면 파란 테두리가 보이고, 클릭하면 주석 입력란이 뜹니다. 디자인 안의 링크나 버튼은 눌러도 동작하지 않습니다.
3. 카드 전체처럼 더 큰 범위를 고르려면 "상위 요소"를 누릅니다.
4. 주석을 쓰고 ⌘+Enter 또는 "추가"를 누릅니다. 오른쪽 아래 목록에서 ×로 지울 수 있습니다.
5. 다 달았으면 "Claude Design에 보내기"를 누릅니다.

주석들은 각 요소의 문구, 크기, DOM 경로, 여는 태그와 함께 수정 요청 하나로 묶여 전송되고, 그 뒤는 `design_reply`와 똑같이 완료 대기, 소스 저장, 미리보기까지 이어집니다. 주석을 다는 시간은 기본 7분이고, 지나면 창이 닫히며 아무것도 보내지 않습니다. 창이 Mac 화면에 뜨기 때문에 휴대폰으로 연 omonitor에서는 쓸 수 없습니다.

### 4. 다시 보기와 내려받기

- "내 디자인 목록 보여줘" → `design_list`
- "Shelf 디자인 미리보기 다시 보여줘" → `design_preview`
- "Shelf 디자인 소스를 `ui/shelf`에 받아줘" → `design_pull` (경로를 안 주면 기본 위치)

### Claude Design이 질문하거나 권한을 요청하면

결과 상태가 `awaiting_input`으로 돌아옵니다.

- `reason: "question"`: Claude Design이 질문을 남긴 것입니다. 답을 말하면 `design_reply`로 전달됩니다.
- `reason: "permission"`: Claude Design 작업이 도구 사용 승인을 기다리는 것입니다. 이 MCP는 승인을 대신 누르지 않습니다. 결과의 `url`을 열어 claude.ai에서 직접 승인한 뒤 "계속 기다려줘"라고 하면 됩니다.

## tool 목록

| tool | 하는 일 | 주요 인자 |
|---|---|---|
| `design_status` | 전용 프로필의 claude.ai 로그인 상태 확인 | 없음 |
| `design_login` | 로그인용 Chrome 창 열기 | 없음 |
| `design_list` | 내 Design 목록 (최신순) | `limit` (기본 20, 최대 100) |
| `design_create` | 새 디자인 생성 | `prompt`, `name`, `projectDir`, 대기 옵션 |
| `design_wait` | 현재 작업이 끝날 때까지 대기 | `projectId`, `projectDir`, 대기 옵션 |
| `design_reply` | 같은 디자인 채팅에 수정 요청이나 답변 보내기 | `projectId`, `message`, `projectDir`, 대기 옵션 |
| `design_annotate` | 요소에 주석을 달아 수정 요청 (데스크톱) | `projectId`, `projectDir`, `file`, `annotateTimeoutSec` (기본 420초), 대기 옵션 |
| `design_preview` | 아트보드를 PNG로 렌더링 | `projectId`, `file`, `width` (기본 1440), `maxImages` (기본 4, 최대 8) |
| `design_pull` | 소스 파일 내려받기 | `projectId`, `projectDir`, `dir` |

대기 옵션은 `design_create`, `design_wait`, `design_reply`, `design_annotate`에 공통입니다.

| 옵션 | 기본값 | 뜻 |
|---|---|---|
| `wait` | `true` | 끝날 때까지 기다릴지 (`design_create`, `design_reply`만) |
| `timeoutSec` | `240` | 최대 대기 시간(초). 넘기면 `generating`으로 돌아옴 |
| `preview` | `true` | 끝나면 미리보기 이미지를 붙일지 |
| `pull` | `true` | 끝나면 소스를 프로젝트에 저장할지 |
| `projectDir` | 필수 | 지금 작업 중인 프로젝트의 절대 경로. 에이전트가 자기 작업 폴더를 넣습니다 |
| `dir` | `<projectDir>/claude-design/<이름>-<id8>/` | 저장 위치. 상대 경로는 `projectDir` 기준 |

`projectDir`를 에이전트가 넘기는 이유: omonitor가 쓰는 omo host는 여러 세션이 MCP 프로세스 하나를 함께 쓰고, 그 프로세스의 작업 폴더는 세션 폴더가 아니어서 서버 쪽에서는 어느 프로젝트인지 알 수 없습니다.

### 상태 값

| 상태 | 뜻 |
|---|---|
| `generating` | 아직 만드는 중 |
| `done` | 파일이 바뀌고 작업이 끝남. 소스 저장과 미리보기가 붙음 |
| `awaiting_input` | 질문(`question`) 또는 권한 승인(`permission`)을 기다림 |
| `no_output` | 작업은 끝났지만 파일이 바뀌지 않음 |
| `stalled` | 10분 동안 아무 진행이 없음 |

`design_annotate`는 주석을 보내지 않고 끝나면 `cancel`, `closed`(탭을 직접 닫음), `timeout`, `no_annotations` 중 하나를 돌려줍니다.

## 받은 소스 파일

```
claude-design/shelf-reading-dashboard-a1b2c3d4/
├── Main.dc.html   # 아트보드 본체 (인라인 스타일 HTML)
├── canvas.json    # 캔버스 구성 (아트보드 크기, 순서 등)
├── support.js     # .dc.html을 띄우는 Claude Design 실행 파일
└── _blob/…        # 업로드한 이미지 등 첨부 파일 (있을 때만)
```

- `Main.dc.html`을 Finder에서 더블클릭해 브라우저로 열면 미리보기와 같은 화면이 나옵니다. Google Fonts 같은 외부 리소스는 원래 링크를 그대로 씁니다.
- `.dc.html`은 `support.js`에 묶인 Claude Design 전용 형식입니다. 디자인이 확정되면 이 파일을 참고해서 실제 프로젝트 코드(React 등)로 구현해 달라고 에이전트에게 요청하는 흐름을 권합니다.
- 내려받기는 **claude.ai → 로컬 한 방향**입니다. 로컬에서 고친 내용은 claude.ai로 올라가지 않습니다.
- 다시 받으면 같은 이름의 파일을 **덮어씁니다.** 받은 파일을 로컬에서 고쳤다면 먼저 git에 커밋하거나, 그 요청에는 `pull: false` 또는 다른 `dir`을 쓰세요. claude.ai 쪽에서 지운 파일은 로컬에서 지워지지 않습니다.

## 설정

### 파일 위치

모든 상태는 `~/.claude-design-mcp/`에 있습니다 (폴더 권한 0700).

| 경로 | 내용 |
|---|---|
| `chrome-profile/` | 전용 Chrome 프로필 (claude.ai 로그인 정보) |
| `daemon.sock` | 데몬 소켓 (권한 0600) |
| `daemon.log` | 데몬 로그 |
| `designs.json` | 디자인별 세션 ID와 마지막 요청 기준점 |
| `cache/` | 미리보기와 주석 창에 쓰는 디자인 파일 사본 |

### 환경 변수

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `CLAUDE_DESIGN_STATE_DIR` | `~/.claude-design-mcp` | 상태 폴더 위치 |
| `CLAUDE_DESIGN_CHROME` | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` | Chrome 실행 파일 |
| `CLAUDE_DESIGN_WAIT_SEC` | `240` | `timeoutSec` 기본값(초) |
| `CLAUDE_DESIGN_BROWSER_IDLE_MS` | `300000` (5분) | 요청이 없을 때 Chrome 창을 닫기까지의 시간 |
| `CLAUDE_DESIGN_IDLE_MS` | `1800000` (30분) | 요청이 없을 때 데몬이 종료하기까지의 시간 |

omo에서는 `mcp.json`의 `env` 항목으로 넘겨야 적용됩니다. 데몬은 처음 띄운 MCP 프로세스의 환경을 물려받으므로, 값을 바꾼 뒤에는 아래 [업데이트](#업데이트)처럼 프로세스를 다시 띄우세요.

## 문제 해결

- **`loggedIn: false`**: [로그인](#처음-한-번-로그인) 과정을 다시 합니다.
- **"The design-profile Chrome login window is still open"**: 로그인 창이 아직 떠 있습니다. 그 창을 앞에 두고 Cmd+Q로 종료한 뒤 다시 시도합니다.
- **"A Cloudflare check may be blocking the headless browser"**: claude.ai가 확인 화면에서 넘어가지 않은 경우입니다. 잠시 뒤 다시 시도하고, 계속되면 `design_login` 창으로 claude.ai를 한 번 열어 확인을 통과한 뒤 Cmd+Q로 닫습니다.
- **"Claude Design is still working on …"**: 이전 요청이 아직 처리 중입니다. 먼저 기다린 뒤 다시 요청합니다.
- **전용 Chrome 창 오른쪽 위의 작은 말풍선**: Chrome이 비정상 종료된 뒤 뜨는 페이지 복원 안내입니다. 닫아도 됩니다.
- **그 밖의 오류**: `~/.claude-design-mcp/daemon.log`를 확인합니다.

## 업데이트

```sh
cd claude-artifacts-mcp
git pull
bun install
pkill -f "$PWD/src/(daemon|mcp)\.ts"
```

마지막 줄은 이전 코드로 떠 있는 데몬과 MCP 프로세스를 내립니다. 다음 tool 호출 때 새 코드로 다시 뜹니다. omo host(omonitor)는 이전 MCP 프로세스를 요청이 없는 상태로 약 10분이 지날 때까지 계속 쓰기 때문에, 이 단계를 빼면 바뀐 내용이 바로 반영되지 않습니다. tool 인자가 바뀐 직후 첫 호출은 omo가 `schema_changed`로 알려주고 에이전트가 자동으로 다시 부릅니다.

## 개발

```sh
bun test           # 단위 테스트
bun run typecheck  # tsc --noEmit
```

| 파일 | 역할 |
|---|---|
| `src/mcp.ts` | stdio MCP 서버, tool 정의, 완료 대기와 자동 저장 |
| `src/ipc.ts` | 데몬 연결 (없으면 자동 실행) |
| `src/daemon.ts` | 브라우저 데몬, 요청 직렬 처리, 유휴 종료 |
| `src/browser.ts` | 전용 Chrome 프로필 실행과 로그인 창 |
| `src/design.ts` | 생성, 수정, 상태 확인, 미리보기, 내려받기, 주석 창 |
| `src/claude.ts` | claude.ai 내부 API 호출, 작업 상태 판정 |
| `src/files.ts` | 디자인 파일 내려받기, 첨부 경로 변환, 폴더 이름 |
| `src/annotate.ts` | 주석 오버레이와 주석 → 수정 요청 메시지 변환 |
| `src/store.ts` | `designs.json` 읽기와 쓰기 |

## 한계

- claude.ai의 비공개 화면 구조와 내부 API에 의존합니다. claude.ai가 바뀌면 깨질 수 있습니다.
- macOS에서만 확인했습니다.
- 디자인 시스템, 모델, effort는 고르지 않고 claude.ai 계정의 기본값을 씁니다.
- 로컬에서 고친 파일을 claude.ai로 올리는 기능과 디자인을 지우는 기능은 없습니다. 지우기는 claude.ai에서 직접 합니다.
- tool을 부르는 동안 전용 Chrome 창이 화면에 보입니다.
