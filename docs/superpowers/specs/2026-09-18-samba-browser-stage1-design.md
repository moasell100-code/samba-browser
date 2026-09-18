# 삼바브라우저 1단계 설계: Electron 브라우저 뼈대 + AI 사이드패널

작성일: 2026-09-18

## 전체 프로젝트 목표 (4단계)

AI 기반 모바일 친화 데스크톱 브라우저. 브라우저 하나 안에서 문자 인증·전화 인증(ARS 포함)이 끝나야 함. 안드로이드 폰 화면을 브라우저 안에 띄우고 AI가 보고 눌러 처리.

| 단계 | 내용 | 상태 |
|---|---|---|
| 1 | Electron 브라우저 뼈대 + AI 사이드패널 (웹페이지 조작 포함) | **이 문서** |
| 2 | scrcpy로 폰 화면을 패널에 표시, 터치/키 전달 | 이후 |
| 3 | 문자 인증번호 자동 입력 | 이후 |
| 4 | 통화 소리 수신 + ARS 번호 누르기 | 이후 |

## 사용자 상황

- 코딩 경험 없음. 단계별로 하나씩, 설치·실행 방법 초보자용 설명 필수.
- PC: Windows 11. Node 24, git, Python 3.13, Claude Code 2.1.258(로그인됨), Codex CLI 설치됨.
- adb/scrcpy: PATH 미등록. 경로는 `C:\Users\canno\Downloads\pt\platform-tools\adb.exe`, `C:\Users\canno\Downloads\pt\scrcpy-win64-v4.1\scrcpy.exe` (2단계에서 사용).
- 폰: 갤럭시 Z플립3 (SM-F711N).

## 확정 결정 사항

1. **AI 두뇌: Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`). 이미 로그인된 Claude Code 구독 계정 사용. API 키·카드 등록 없음.
   - 위험: Anthropic이 구독 계정의 외부 앱 사용을 제한할 수 있음. 그 경우 `ANTHROPIC_API_KEY` 방식으로 전환(에이전트 모듈 한 곳만 수정).
2. **AI가 페이지를 보는 방식: 구조 읽기(A)**. 페이지 텍스트 + 상호작용 요소(버튼/링크/입력칸) 목록에 번호를 붙여 전달. 스크린샷 방식은 채택 안 함(2단계 폰 화면에서만 스크린샷 사용).
3. **1단계 범위: 대화 + 웹페이지 조작(B)**. AI가 클릭/입력/이동을 직접 실행.
4. 기술 스택: Electron + electron-vite + React 19 + TypeScript + Tailwind CSS + Zustand. 세미콜론 없음, 작은따옴표, 들여쓰기 2칸, `any` 금지.

## 화면 구성

```
┌──────────────────────────────┬──────────────┐
│ [←][→][⟳] 주소창      [📱모바일] │  AI 채팅 패널  │
├──────────────────────────────┤              │
│                              │  대화 내용    │
│        웹페이지               │  (진행 로그)  │
│                              │              │
│                              ├──────────────┤
│                              │ 입력칸 [전송] │
│                              │ [중단]        │
└──────────────────────────────┴──────────────┘
```

- 왼쪽: 주소창, 뒤로/앞으로/새로고침. 📱 버튼으로 모바일 모드 토글(갤럭시 UA + 412×915 뷰포트 + 터치 이벤트 에뮬레이션).
- 오른쪽: AI 채팅 패널. 드래그로 폭 조절(최소 280px). 2단계에서 폰 화면 패널이 이 아래에 추가될 자리 확보.
- 반응형: 창 폭 900px 미만이면 패널 접기 버튼 제공.

## 아키텍처 (레이어 분리)

```
samba_browser/
  src/main/          Electron 메인 프로세스
    index.ts           창 생성, WebContentsView 배치
    browser/           탭 없는 단일 웹뷰 관리, 네비게이션, 모바일 에뮬레이션
    ipc/               렌더러↔메인 IPC 핸들러 (채널 이름은 shared/ipc.ts에 정의)
    agent/             Agent SDK 세션 관리, MCP 도구 등록, 실행 루프
  src/preload/
    browser.ts         웹페이지 안에서 실행: 스냅샷 생성, click/type/scroll 실행기
    renderer.ts        React UI용 contextBridge
  src/renderer/        React UI
    components/        AddressBar, ChatPanel, MessageList, ChatInput, MobileToggle
    stores/            Zustand: chatStore(메시지, 실행 상태), browserStore(URL, 모바일 여부)
  src/shared/          IPC 채널 이름, DTO 타입 (main/renderer 공용)
  docs/                설계·실행 문서
```

### 모듈별 책임

| 모듈 | 하는 일 | 의존 |
|---|---|---|
| `main/browser` | 웹뷰 로드/이동, 모바일 UA·뷰포트 설정, preload 함수 호출 | Electron |
| `preload/browser` | DOM 스냅샷(`{url, title, text, elements[]}`), `click(id)`, `type(id, text)`, `scroll(dir)` | DOM |
| `main/agent` | Agent SDK `query()` 호출, MCP 도구(navigate/click/type/scroll/wait/done) 정의, 20회 제한, 중단 | Agent SDK, main/browser |
| `renderer` | UI 표시, 사용자 입력을 IPC로 전달, 진행 로그 표시 | shared/ipc |

## 데이터 흐름 (AI 동작)

1. 사용자가 채팅에 지시 입력 → IPC `agent:run(prompt)`.
2. `main/agent`가 Agent SDK 세션 시작. 시스템 프롬프트에 역할·안전 규칙 포함.
3. Claude가 MCP 도구 호출 → 앱이 실행:
   - `get_page()` → 현재 페이지 스냅샷 반환 (텍스트 최대 8,000자, 요소 최대 150개, 각 요소 `id, tag, text, type, href`)
   - `navigate(url)`, `click(id)`, `type(id, text, submit?)`, `scroll(up|down)`, `wait(ms ≤ 5000)`
   - `done(summary)` → 종료
4. 각 도구 실행 결과를 채팅 패널에 한 줄 로그로 표시 ("3번 버튼 클릭").
5. 도구 호출 20회 초과 또는 사용자가 [중단] 누르면 세션 취소.

## 안전장치

- **위험 단어 확인**: 클릭 대상 텍스트 또는 입력 값에 `결제, 구매, 송금, 이체, 삭제, 탈퇴, 주문` 포함 시 실행 전 렌더러에 확인 팝업. 거절하면 도구는 `"사용자가 거부함"` 반환.
- **비밀번호 미입력**: `type` 대상이 `type=password` 입력칸이면 거부하고 "직접 입력하세요" 안내.
- **반복 상한**: 도구 호출 20회.
- **중단 버튼**: 즉시 세션 abort.

## 에러 처리

- Agent SDK 인증 실패(로그인 없음/구독 제한) → 채팅 패널에 원인과 해결법(`claude login` 또는 API 키 전환) 표시.
- 페이지 로딩 실패 → 도구 결과에 오류 문자열 반환, AI가 재시도 판단.
- 요소 id 없음(페이지 바뀜) → "요소 없음, get_page 다시 호출" 반환.
- 모든 IPC 핸들러 try/catch, 렌더러에 `{ok, data|error}` 형식으로 일관 응답.

## 설정

- `config.json`(사용자 폴더 `%APPDATA%/samba-browser/`): 모델(`sonnet`|`opus`), 패널 폭, 마지막 URL. 없으면 기본값 생성.
- API 키 방식 전환은 `ANTHROPIC_API_KEY` 환경변수 존재 시 자동.

## 테스트

- 단위: preload 스냅샷 함수(jsdom), 위험 단어 판정, 도구 인자 검증(zod). Vitest.
- 수동 시나리오(완료 기준):
  1. 앱 실행 → 주소창에 사이트 입력 → 표시됨.
  2. 📱 클릭 → 모바일 레이아웃으로 바뀜.
  3. "구글 열어서 '삼바웨이브' 검색해" → AI가 navigate → type → 결과 페이지까지 완료, 로그 표시.
  4. [중단] 누르면 즉시 멈춤.

## 1단계 완료 기준

위 수동 시나리오 4개 통과. 초보자용 설치·실행 문서(`docs/실행방법.md`) 작성.

## 이후 단계 메모 (설계 아님)

- 2단계: scrcpy 4.1 실행 → 화면 스트림을 패널에 표시, 좌표 터치 전달. adb 끊김 대비 `kill-server/start-server` 재시도.
- 4단계: Windows PC는 블루투스 HFP 헤드셋 역할 미지원. 대안 1순위 scrcpy `--audio-source=voice-call` 테스트. ARS 번호는 폰 화면 키패드 터치.
