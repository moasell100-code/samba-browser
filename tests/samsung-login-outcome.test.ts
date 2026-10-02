import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../src/main/browser/tab-manager'
import { observeSamsungLoginAlerts } from '../src/main/finance/samsung-login-outcome'

const attach = vi.hoisted(() => vi.fn(() => true))
vi.mock('../src/main/browser/emulation', () => ({ ensureDebuggerAttached: attach }))
const LOGIN = 'https://www.samsungcard.com/personal/login/UHPPCO0301M0.jsp'
const disposals: Array<() => void> = []

function fixture(): {
  tab: Tab
  wc: EventEmitter
  debug: EventEmitter
  command: ReturnType<typeof vi.fn>
  changeUrl: (url: string) => void
  emit: (changes?: Record<string, unknown>, sessionId?: string) => void
} {
  let url = LOGIN
  const command = vi.fn().mockResolvedValue({})
  const debug = Object.assign(new EventEmitter(), { sendCommand: command, detach: vi.fn() })
  const wc = Object.assign(new EventEmitter(), {
    getURL: () => url,
    isDestroyed: () => false,
    debugger: debug
  })
  const tab = { view: { webContents: wc } } as unknown as Tab
  return {
    tab,
    wc,
    debug,
    command,
    changeUrl: (next) => {
      url = next
    },
    emit: (changes = {}, sessionId) => {
      debug.emit(
        'message',
        {},
        'Page.javascriptDialogOpening',
        {
          type: 'alert',
          url: LOGIN,
          message: '아이디 또는 비밀번호를 잘못 입력하였습니다.',
          ...changes
        },
        sessionId
      )
    }
  }
}

beforeEach(() => {
  attach.mockReset().mockReturnValue(true)
})
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('scoped Samsung native login alert observer', () => {
  it('handles only a new exact-page alert and retains only a fixed classification', async () => {
    const f = fixture()
    const observer = await observeSamsungLoginAlerts(f.tab)
    disposals.push(observer.dispose)
    expect(f.command).toHaveBeenCalledWith('Page.enable')
    expect(observer.getOutcome()).toBe('unknown')
    f.emit({ message: 'PRIVATE_ACCOUNT님의 아이디 또는 비밀번호를 잘못 입력하였습니다.' })
    expect(observer.getOutcome()).toBe('wrong_credentials')
    expect(f.command).toHaveBeenLastCalledWith('Page.handleJavaScriptDialog', { accept: true })
    expect(JSON.stringify(f.command.mock.calls)).not.toContain('PRIVATE_ACCOUNT')
    observer.dispose()
    observer.dispose()
    expect(f.debug.listenerCount('message')).toBe(0)
    expect(f.wc.listenerCount('destroyed')).toBe(0)
    const count = f.command.mock.calls.length
    f.emit()
    expect(f.command).toHaveBeenCalledTimes(count)
  })

  it.each(['confirm', 'prompt', 'beforeunload', undefined])(
    'never acknowledges %s',
    async (type) => {
      const f = fixture()
      const observer = await observeSamsungLoginAlerts(f.tab)
      disposals.push(observer.dispose)
      f.emit({ type })
      expect(f.command).toHaveBeenCalledTimes(1)
      expect(observer.getOutcome()).toBe('unknown')
    }
  )

  it('ignores another origin, unrelated Samsung page, child debugger session, and missing event URL', async () => {
    const f = fixture()
    const observer = await observeSamsungLoginAlerts(f.tab)
    disposals.push(observer.dispose)
    for (const url of [
      'https://other.test/',
      'https://www.samsungcard.com/personal/payment.jsp',
      undefined
    ])
      f.emit({ url })
    f.emit({}, 'child-session')
    expect(f.command).toHaveBeenCalledTimes(1)
    expect(observer.getOutcome()).toBe('unknown')
  })

  it.each([
    ['비밀번호를 정확하게 입력해 주시기 바랍니다.', 'input_required'],
    ['보안프로그램을 설치해 주시기 바랍니다.', 'security_program_required'],
    ['추가 인증이 필요합니다.', 'additional_auth'],
    ['보안문자를 입력해 주세요.', 'captcha'],
    ['일반 안내', 'unknown']
  ])('classifies a bounded message without exporting it (%s)', async (message, outcome) => {
    const f = fixture()
    const observer = await observeSamsungLoginAlerts(f.tab)
    disposals.push(observer.dispose)
    f.emit({ message })
    expect(observer.getOutcome()).toBe(outcome)
    expect(f.command).toHaveBeenLastCalledWith('Page.handleJavaScriptDialog', { accept: true })
  })

  it('does not replay or handle alerts emitted while Page.enable is starting', async () => {
    const f = fixture()
    f.command.mockImplementationOnce(async () => {
      f.emit()
      return {}
    })
    const observer = await observeSamsungLoginAlerts(f.tab)
    disposals.push(observer.dispose)
    expect(observer.getOutcome()).toBe('unknown')
    expect(f.command).toHaveBeenCalledTimes(1)
  })

  it('does not accumulate listeners, detach shared debugger, or remove other modules listeners', async () => {
    const f = fixture()
    const other = vi.fn()
    f.debug.on('message', other)
    const first = await observeSamsungLoginAlerts(f.tab)
    disposals.push(first.dispose)
    const duplicate = await observeSamsungLoginAlerts(f.tab)
    expect(duplicate.getOutcome()).toBe('unavailable')
    duplicate.dispose()
    expect(f.debug.listenerCount('message')).toBe(2)
    first.dispose()
    expect(f.debug.listenerCount('message')).toBe(1)
    const next = await observeSamsungLoginAlerts(f.tab)
    disposals.push(next.dispose)
    expect(f.debug.listenerCount('message')).toBe(2)
    expect(
      (f.debug as unknown as { detach: ReturnType<typeof vi.fn> }).detach
    ).not.toHaveBeenCalled()
  })

  it('stops on abort, navigation, destroyed content and lifetime without affecting another tab', async () => {
    vi.useFakeTimers()
    for (const stop of ['abort', 'navigate', 'destroyed', 'timeout']) {
      const f = fixture()
      const signal = new AbortController()
      const observer = await observeSamsungLoginAlerts(f.tab, { signal: signal.signal })
      disposals.push(observer.dispose)
      if (stop === 'abort') signal.abort()
      if (stop === 'navigate') {
        f.changeUrl('https://other.test/')
        f.wc.emit('did-navigate')
      }
      if (stop === 'destroyed') f.wc.emit('destroyed')
      if (stop === 'timeout') await vi.advanceTimersByTimeAsync(120000)
      f.emit()
      expect(f.command).toHaveBeenCalledTimes(1)
      expect(f.debug.listenerCount('message')).toBe(0)
    }
  })

  it('normalizes attach/enable failures and bounds startup with cleanup', async () => {
    const f = fixture()
    attach.mockReturnValueOnce(false)
    expect((await observeSamsungLoginAlerts(f.tab)).getOutcome()).toBe('unavailable')
    f.command.mockRejectedValueOnce(new Error('PRIVATE_PROTOCOL_ERROR'))
    expect((await observeSamsungLoginAlerts(f.tab)).getOutcome()).toBe('unavailable')
    expect(f.debug.listenerCount('message')).toBe(0)
    vi.useFakeTimers()
    f.command.mockReturnValueOnce(new Promise(() => undefined))
    const pending = observeSamsungLoginAlerts(f.tab)
    await vi.advanceTimersByTimeAsync(10001)
    expect((await pending).getOutcome()).toBe('unavailable')
    expect(f.debug.listenerCount('message')).toBe(0)
  })

  it('aborts pending Page.enable promptly and refuses unsupported pages before attach', async () => {
    const f = fixture()
    f.changeUrl('http://www.samsungcard.com/personal/login/UHPPCO0301M0.jsp')
    expect((await observeSamsungLoginAlerts(f.tab)).getOutcome()).toBe('unsupported')
    expect(attach).not.toHaveBeenCalled()
    f.changeUrl(LOGIN)
    f.command.mockReturnValueOnce(new Promise(() => undefined))
    const controller = new AbortController()
    const pending = observeSamsungLoginAlerts(f.tab, { signal: controller.signal })
    controller.abort()
    expect((await pending).getOutcome()).toBe('cancelled')
    expect(f.debug.listenerCount('message')).toBe(0)
  })

  it('returns unknown for conflicting outcomes and never exports oversized messages', async () => {
    const f = fixture()
    const observer = await observeSamsungLoginAlerts(f.tab)
    disposals.push(observer.dispose)
    f.emit()
    f.emit({ message: '보안문자를 입력해 주세요.' })
    expect(observer.getOutcome()).toBe('unknown')
    f.emit({ message: 'PRIVATE_MESSAGE'.repeat(1000) })
    expect(observer.getOutcome()).toBe('unknown')
    expect(JSON.stringify(f.command.mock.calls)).not.toContain('PRIVATE_MESSAGE')
  })
})
