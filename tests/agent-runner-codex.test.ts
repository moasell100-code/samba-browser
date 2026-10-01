import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../src/main/agent/tools'
import type { CodexInput, CodexEvent } from '../src/main/agent/provider-codex'
import type { AgentEvent } from '../src/shared/ipc'
import type { SettingsStore } from '../src/main/settings/store'
import type { TabManager } from '../src/main/browser/tab-manager'

const state = vi.hoisted(() => ({
  context: null as ToolContext | null,
  input: null as CodexInput | null,
  close: vi.fn(async () => {}),
  run: null as null | (() => AsyncGenerator<CodexEvent>)
}))

vi.mock('../src/main/agent/tools', () => ({
  createSambaTools: (context: ToolContext) => {
    state.context = context
    return { marker: 'same-tools' }
  },
  SAMBA_TOOL_NAMES: []
}))
vi.mock('../src/main/agent/codex-mcp', () => ({
  startCodexMcp: vi.fn(async () => ({
    url: 'http://127.0.0.1:41000/mcp',
    bearerToken: 'test-only',
    close: state.close
  }))
}))
vi.mock('../src/main/agent/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/agent/provider')>()),
  agentBackend: () => 'codex',
  runCodexQuery: (input: CodexInput) => {
    state.input = input
    return state.run!()
  }
}))

const { AgentRunner } = await import('../src/main/agent/runner')
const { startCodexMcp } = await import('../src/main/agent/codex-mcp')

function setup(): { runner: InstanceType<typeof AgentRunner>; events: AgentEvent[] } {
  const events: AgentEvent[] = []
  const runner = new AgentRunner(
    {} as TabManager,
    {
      get: () => ({
        aiProvider: 'codex_subscription',
        language: 'ko',
        permissionMode: 'guard',
        finalConfirm: true,
        maxToolCalls: 2,
        dangerWords: []
      })
    } as unknown as SettingsStore,
    (event) => events.push(event)
  )
  return { runner, events }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.context = null
  state.input = null
  state.run = async function* () {
    yield { type: 'done', ok: true }
  }
})

describe('Codex browser runner', () => {
  it('passes the guarded tools and reports their actual call count', async () => {
    state.run = async function* () {
      expect(state.context?.tick()).toBeNull()
      expect(state.context?.tick()).toBeNull()
      expect(state.context?.tick()).toContain('limit')
      yield { type: 'done', ok: true }
    }
    const { runner, events } = setup()
    await runner.run('Read the current page')
    expect(startCodexMcp).toHaveBeenCalledWith({
      server: { marker: 'same-tools' },
      signal: state.input!.abort.signal
    })
    expect(state.input?.mcpServer).toEqual({
      name: 'samba',
      url: 'http://127.0.0.1:41000/mcp',
      bearerToken: 'test-only'
    })
    expect(state.context).toMatchObject({ mode: 'guard', finalConfirm: true })
    expect(events.at(-1)).toMatchObject({ state: 'done', toolCalls: 3 })
    expect(state.close).toHaveBeenCalledOnce()
  })

  it('waits for the existing confirmation response rather than approving it', async () => {
    const { runner, events } = setup()
    state.run = async function* () {
      const response = state.context!.confirm('Action needing approval', 'danger')
      const pending = events.find((event) => event.type === 'confirm')
      expect(pending).toBeDefined()
      if (pending?.type !== 'confirm') throw new Error('Expected confirmation')
      runner.resolveConfirm(pending.requestId, false)
      expect(await response).toBe(false)
      yield { type: 'done', ok: true }
    }
    await runner.run('Check')
    expect(state.close).toHaveBeenCalledOnce()
  })

  it('closes the endpoint after provider failure', async () => {
    state.run = async function* () {
      yield await Promise.reject(new Error('provider unavailable'))
    }
    const { runner, events } = setup()
    await runner.run('Check')
    expect(events.at(-1)).toMatchObject({ state: 'failed', message: 'provider unavailable' })
    expect(state.close).toHaveBeenCalledOnce()
  })

  it('rejects any late tool call after stopping', async () => {
    const { runner, events } = setup()
    state.run = async function* () {
      runner.stop()
      expect(state.context!.tick()).toContain('중단')
      expect(state.input!.abort.signal.aborted).toBe(true)
      yield { type: 'done', ok: true }
    }
    await runner.run('Check')
    expect(events.at(-1)).toMatchObject({ state: 'stopped' })
    expect(events.some((event) => event.type === 'status' && event.state === 'done')).toBe(false)
    expect(state.close).toHaveBeenCalledOnce()
  })
})
