import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, basename } from 'node:path'
import { CODEX_DEFAULT_MODEL } from '../src/shared/ai'
import {
  buildCodexArgs,
  CODEX_SUBSCRIPTION_REQUIRED,
  CODEX_MCP_TOKEN_ENV,
  codexSubscriptionEnv,
  composeCodexPrompt,
  hasCodexSubscription,
  isChatGptLoginStatus,
  parseCodexLine,
  runCodex,
  splitLines,
  type CodexChild,
  type CodexEvent,
  type CodexSpawn
} from '../src/main/agent/provider-codex'

// 실제 `codex exec --json` 이 뿜은 줄(이 PC 의 codex-cli 0.150.1 로 확인한 봉투 모양)
const FIXTURE = [
  '{"type":"thread.started","thread_id":"01a0b7a9-b0c5-7b02-924a-000b608f2083"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"생각 중"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"안녕하세요"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"mcp_tool_call","server":"samba","tool":"open_url","status":"completed"}}',
  '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":3}}'
]

describe('buildCodexArgs — 실제로 확인한 인자만 쓴다', () => {
  it('비대화 JSONL 실행 인자를 만든다', () => {
    const args = buildCodexArgs({ model: 'gpt-5.6' })
    expect(args.slice(0, 2)).toEqual(['exec', '--json'])
    expect(args).toContain('--skip-git-repo-check')
    expect(args).toContain('--ignore-user-config')
    expect(args).toEqual(expect.arrayContaining(['--sandbox', 'read-only']))
    expect(args).toEqual(expect.arrayContaining(['-m', 'gpt-5.6']))
    expect(args).toContain('forced_login_method="chatgpt"')
    expect(args).toContain('model_provider="openai"')
    expect(args).toContain('features.shell_tool=false')
    expect(args).toContain('features.unified_exec=false')
    expect(args).toContain('web_search="disabled"')
  })

  it('모델이 비어 있으면 -m 을 붙이지 않는다', () => {
    expect(buildCodexArgs({ model: '  ' })).not.toContain('-m')
  })

  it('Codex 기본 설정은 가짜 모델 이름으로 보내지 않고 CLI 기본값을 사용한다', () => {
    const args = buildCodexArgs({ model: CODEX_DEFAULT_MODEL })
    expect(args).not.toContain('-m')
    expect(args.join(' ')).not.toContain(CODEX_DEFAULT_MODEL)
    expect(args).toContain('forced_login_method="chatgpt"')
  })

  it('로컬 HTTP MCP 서버가 있을 때 토큰 값 대신 환경 이름만 인자로 전달한다', () => {
    expect(buildCodexArgs({ model: 'gpt-5.6' }).join(' ')).not.toContain('mcp_servers')
    const args = buildCodexArgs({
      model: 'gpt-5.6',
      mcpServer: { name: 'samba', url: 'http://127.0.0.1:4123/mcp', bearerToken: 'private-token' }
    })
    const cfg = args[args.indexOf('-c', args.indexOf('mcp_servers') - 1)]
    expect(cfg).toBe('-c')
    expect(args.join(' ')).toContain(
      `mcp_servers.samba={url="http://127.0.0.1:4123/mcp",bearer_token_env_var="${CODEX_MCP_TOKEN_ENV}",required=true,default_tools_approval_mode="approve"}`
    )
    expect(args.join(' ')).not.toContain('private-token')
    expect(args).toEqual(expect.arrayContaining(['--sandbox', 'read-only']))
    expect(args).toContain('features.shell_tool=false')
    expect(args).toContain('features.unified_exec=false')
    expect(args.some((arg) => arg.startsWith('approval_policy='))).toBe(false)
    expect(args.filter((arg) => arg.includes('default_tools_approval_mode'))).toHaveLength(1)
  })

  it.each([
    'https://remote.invalid/mcp',
    'http://localhost:4123/mcp',
    'http://127.0.0.1:4123/mcp?token=secret'
  ])('로컬 브리지 외 주소는 허용하지 않는다: %s', (url) =>
    expect(() =>
      buildCodexArgs({
        model: '',
        mcpServer: { name: 'samba', url, bearerToken: 'private-token' }
      })
    ).toThrow('codex_invalid_mcp_server')
  )

  it('시스템 프롬프트는 프롬프트 앞머리로 합쳐 stdin 으로 넣는다', () => {
    expect(composeCodexPrompt('규칙', '할 일')).toBe('규칙\n\n---\n\n할 일')
    expect(composeCodexPrompt('   ', '할 일')).toBe('할 일')
  })
})

describe('parseCodexLine — JSONL 사건 파싱', () => {
  it('agent_message 만 텍스트로 올리고 reasoning 은 버린다', () => {
    const events = FIXTURE.flatMap(parseCodexLine)
    expect(events).toEqual([
      { type: 'text', text: '안녕하세요' },
      { type: 'step', label: 'samba.open_url', ok: true },
      { type: 'done', ok: true }
    ])
  })

  it('turn.failed · error 는 실패로 옮긴다', () => {
    expect(parseCodexLine('{"type":"error","message":"네트워크 끊김"}')).toEqual([
      { type: 'error', message: '네트워크 끊김' }
    ])
    expect(parseCodexLine('{"type":"turn.failed","error":{"message":"한도 초과"}}')).toEqual([
      { type: 'done', ok: false, message: '한도 초과' }
    ])
  })

  it('실패한 도구 호출은 ok:false 로 표시한다', () => {
    expect(
      parseCodexLine(
        '{"type":"item.completed","item":{"type":"command_execution","command":"ls","status":"failed"}}'
      )
    ).toEqual([{ type: 'step', label: 'ls', ok: false }])
  })

  it('JSON 이 아니거나 모르는 사건은 조용히 버린다', () => {
    expect(parseCodexLine('Reading additional input from stdin...')).toEqual([])
    expect(parseCodexLine('{깨진')).toEqual([])
    expect(parseCodexLine('{"type":"item.started","item":{"type":"agent_message"}}')).toEqual([])
  })

  it('splitLines 는 끊긴 마지막 조각을 다음 청크로 넘긴다', () => {
    expect(splitLines('a\r\nb\nc')).toEqual({ lines: ['a', 'b'], rest: 'c' })
  })
})

// 가짜 codex 프로세스: 준 줄들을 그대로 stdout 으로 흘린다
function fakeChild(
  chunks: string[],
  exitCode: number | null = 0
): CodexChild & { written: string[]; killed: boolean } {
  const emitter = new EventEmitter()
  const child = {
    stdout: (async function* () {
      for (const c of chunks) yield c
      emitter.emit('close', exitCode)
    })(),
    stdin: {
      write: (chunk: string) => child.written.push(chunk),
      end: () => child.written.push('<end>')
    },
    kill: (): boolean => {
      child.killed = true
      return true
    },
    on: emitter.on.bind(emitter),
    written: [] as string[],
    killed: false
  }
  return child as unknown as CodexChild & { written: string[]; killed: boolean }
}

function loggedInSpawn(child: CodexChild): CodexSpawn {
  return (_command, args) =>
    args[0] === 'login' ? fakeChild(['Logged in using ChatGPT\n']) : child
}

async function collect(stream: AsyncGenerator<CodexEvent>): Promise<CodexEvent[]> {
  const out: CodexEvent[] = []
  for await (const e of stream) out.push(e)
  return out
}

describe('runCodex — 스트림 어댑터', () => {
  it('프롬프트를 stdin 으로 넣고 바로 닫는다(닫지 않으면 codex 가 입력을 기다린다)', async () => {
    const child = fakeChild([FIXTURE.join('\n') + '\n'])
    const events = await collect(
      runCodex(
        {
          prompt: '할 일',
          systemPrompt: '규칙',
          model: 'gpt-5.6',
          abort: new AbortController()
        },
        loggedInSpawn(child)
      )
    )
    expect(child.written).toEqual(['규칙\n\n---\n\n할 일', '<end>'])
    expect(events.at(-1)).toEqual({ type: 'done', ok: true })
  })

  it('청크가 줄 중간에서 끊겨도 한 사건으로 합친다', async () => {
    const joined = FIXTURE.join('\n') + '\n'
    const child = fakeChild([joined.slice(0, 120), joined.slice(120)])
    const events = await collect(
      runCodex(
        { prompt: 'p', systemPrompt: '', model: '', abort: new AbortController() },
        loggedInSpawn(child)
      )
    )
    expect(events).toContainEqual({ type: 'text', text: '안녕하세요' })
  })

  it('끝 사건 없이 스트림이 닫히면 실패로 마무리한다', async () => {
    const child = fakeChild(['{"type":"turn.started"}\n'])
    const events = await collect(
      runCodex(
        { prompt: 'p', systemPrompt: '', model: '', abort: new AbortController() },
        loggedInSpawn(child)
      )
    )
    expect(events).toEqual([{ type: 'done', ok: false, message: 'codex_stream_closed' }])
  })

  it('이미 중단한 실행은 상태 확인이나 모델 실행을 시작하지 않는다', async () => {
    const child = fakeChild([FIXTURE.join('\n') + '\n'])
    const abort = new AbortController()
    abort.abort()
    const spawnImpl = vi.fn(() => child)
    await collect(runCodex({ prompt: 'p', systemPrompt: '', model: '', abort }, spawnImpl))
    expect(spawnImpl).not.toHaveBeenCalled()
  })

  it('실행 자체가 실패하면(설치 안 됨) 실패 사건 하나로 끝난다', async () => {
    const events = await collect(
      runCodex({ prompt: 'p', systemPrompt: '', model: '', abort: new AbortController() }, () => {
        throw new Error('ENOENT')
      })
    )
    expect(events).toEqual([{ type: 'done', ok: false, message: CODEX_SUBSCRIPTION_REQUIRED }])
  })
})

describe('Codex 구독 경계', () => {
  it.each([true, false])(
    '실행 전용 임시 폴더를 만들고 인증 성공=%s 뒤에 지운다',
    async (loggedIn) => {
      const folders: string[] = []
      const spawnImpl: CodexSpawn = (_command, args, cwd) => {
        expect(cwd).toBeTruthy()
        expect(dirname(cwd!)).toBe(tmpdir())
        expect(basename(cwd!)).toMatch(/^samba-codex-/)
        expect(existsSync(cwd!)).toBe(true)
        folders.push(cwd!)
        return args[0] === 'login'
          ? fakeChild(
              [loggedIn ? 'Logged in using ChatGPT\n' : 'Not logged in\n'],
              loggedIn ? 0 : 1
            )
          : fakeChild(['{"type":"turn.completed"}\n'])
      }
      await collect(
        runCodex(
          {
            prompt: 'p',
            systemPrompt: '',
            model: '',
            abort: new AbortController()
          },
          spawnImpl
        )
      )
      expect(folders.length).toBe(loggedIn ? 2 : 1)
      expect(new Set(folders).size).toBe(1)
      expect(existsSync(folders[0])).toBe(false)
    }
  )

  it('인증 저장소 경로만 유지하고 API 키·사용자 지정 provider·실행 주입 환경을 차단한다', () => {
    const source = {
      Path: 'bin',
      USERPROFILE: 'user',
      CODEX_HOME: 'codex-home',
      TEMP: 'temp',
      OPENAI_API_KEY: 'secret',
      CODEX_API_KEY: 'secret',
      ANTHROPIC_API_KEY: 'secret',
      OPENAI_BASE_URL: 'https://paid.invalid',
      CODEX_MODEL_PROVIDER: 'gateway',
      CODEX_CONFIG: 'override',
      CODEX_ACCESS_TOKEN: 'secret',
      NODE_OPTIONS: '--require unsafe.js',
      HTTPS_PROXY: 'https://paid.invalid',
      CUSTOM_PROVIDER_KEY: 'secret'
    }
    expect(codexSubscriptionEnv(source)).toEqual({
      Path: 'bin',
      USERPROFILE: 'user',
      CODEX_HOME: 'codex-home',
      TEMP: 'temp'
    })
    expect(source.OPENAI_API_KEY).toBe('secret')
  })

  it.each([
    ['Logged in using an API key - sk-private\n', 0],
    ['Not logged in\n', 1],
    ['Logged in using ChatGPT\n', 1],
    ['unknown login mode\n', 0],
    ['Not logged in\nLogged in using ChatGPT\n', 0]
  ] as const)('불명확한 로그인은 실행하지 않는다: %s', (output, code) => {
    expect(isChatGptLoginStatus(output, code)).toBe(false)
  })

  it('ChatGPT 확인은 성공 코드와 명확한 상태 줄을 모두 요구한다', () => {
    expect(isChatGptLoginStatus('WARNING: optional notice\nLogged in using ChatGPT\r\n', 0)).toBe(
      true
    )
  })

  it('API 키 로그인 상태가 나오면 모델 실행과 재시도 없이 중단하고 원문은 숨긴다', async () => {
    const spawnImpl = vi.fn<CodexSpawn>(() =>
      fakeChild(['Logged in using an API key - sk-private\n'])
    )
    const events = await collect(
      runCodex(
        {
          prompt: 'p',
          systemPrompt: '',
          model: '',
          abort: new AbortController()
        },
        spawnImpl
      )
    )
    expect(spawnImpl).toHaveBeenCalledTimes(1)
    expect(spawnImpl.mock.calls[0][1]).toEqual(['login', 'status'])
    expect(events).toEqual([{ type: 'done', ok: false, message: CODEX_SUBSCRIPTION_REQUIRED }])
    expect(JSON.stringify(events)).not.toContain('sk-private')
  })

  it('검사와 실제 실행 모두 같은 정제 환경을 받는다', async () => {
    const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = []
    const spawnImpl: CodexSpawn = (_command, args, _cwd, env) => {
      calls.push({ args, env })
      return args[0] === 'login'
        ? fakeChild(['Logged in using ChatGPT\n'])
        : fakeChild(['{"type":"turn.failed","error":{"message":"usage limit reached"}}\n'])
    }
    vi.stubEnv('OPENAI_API_KEY', 'private-test-key')
    try {
      const events = await collect(
        runCodex(
          {
            prompt: 'p',
            systemPrompt: '',
            model: '',
            abort: new AbortController()
          },
          spawnImpl
        )
      )
      expect(calls).toHaveLength(2)
      expect(calls[0].args).toEqual(['login', 'status'])
      expect(calls[1].args[0]).toBe('exec')
      expect(calls.every(({ env }) => !env?.OPENAI_API_KEY)).toBe(true)
      expect(events).toEqual([{ type: 'done', ok: false, message: 'usage limit reached' }])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('MCP 토큰은 모델 실행 환경에만 넣고 상태 검사·프롬프트·인자에는 넣지 않는다', async () => {
    const login = fakeChild(['Logged in using ChatGPT\n'])
    const model = fakeChild(['{"type":"turn.completed"}\n'])
    const spawnImpl = vi.fn<CodexSpawn>((_command, args) => (args[0] === 'login' ? login : model))
    await collect(
      runCodex(
        {
          prompt: 'p',
          systemPrompt: '',
          model: '',
          abort: new AbortController(),
          mcpServer: {
            name: 'samba',
            url: 'http://127.0.0.1:4123/mcp',
            bearerToken: 'private-token'
          }
        },
        spawnImpl
      )
    )
    expect(spawnImpl.mock.calls[0][3]?.[CODEX_MCP_TOKEN_ENV]).toBeUndefined()
    expect(spawnImpl.mock.calls[1][3]?.[CODEX_MCP_TOKEN_ENV]).toBe('private-token')
    expect(JSON.stringify(spawnImpl.mock.calls.map((call) => call[1]))).not.toContain(
      'private-token'
    )
    expect(model.written.join('')).not.toContain('private-token')
  })

  it('상태 확인이 멈추면 프로세스를 종료하고 실패로 닫는다', async () => {
    const child = fakeChild([])
    child.stdout = (async function* () {
      yield ''
      await new Promise(() => undefined)
    })()
    expect(await hasCodexSubscription(() => child, undefined, undefined, 10)).toBe(false)
    expect(child.killed).toBe(true)
  })
})
