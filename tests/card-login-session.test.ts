import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabManager } from '../src/main/browser/tab-manager'
import type { VaultService } from '../src/main/vault/service'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'
import { createSambaTools } from '../src/main/agent/tools'
import { pageBridge } from '../src/main/browser/page-bridge'
import { inspectCardPage } from '../src/main/finance/card-page-diagnostics'
import { observeSamsungLoginAlerts } from '../src/main/finance/samsung-login-outcome'
import {
  inspectLotteKeypadStatus,
  restoreCardSession
} from '../src/main/finance/card-login-session'

vi.mock('../src/main/agent/tools', () => ({ createSambaTools: vi.fn() }))
vi.mock('../src/main/finance/samsung-login-outcome', () => ({ observeSamsungLoginAlerts: vi.fn() }))
vi.mock('../src/main/finance/card-page-diagnostics', async (load) => {
  const actual = await load<typeof import('../src/main/finance/card-page-diagnostics')>()
  return { ...actual, inspectCardPage: vi.fn() }
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

const SIGNED_OUT = { issuer: 'samsung_card', state: 'signed_out', auth: 'signed_out' } as const
const SIGNED_IN = { issuer: 'samsung_card', state: 'ready', auth: 'signed_in' } as const

function fixture(overrides: Partial<Settings> = {}): {
  options: Parameters<typeof restoreCardSession>[0]
  focus: ReturnType<typeof vi.fn>
  login: ReturnType<typeof vi.fn>
  otherTool: ReturnType<typeof vi.fn>
  setUrl: (url: string) => void
} {
  let url = 'https://www.samsungcard.com/personal/login/UHPPCO0301M0.jsp'
  const tab = {
    id: 'synthetic-card-tab',
    profile: 'default',
    view: { webContents: { getURL: () => url, isDestroyed: () => false } }
  } as unknown as Tab
  const focus = vi.fn()
  const tabs = {
    get: () => tab,
    focusTarget: focus,
    active: () => tab,
    agentTarget: () => tab
  } as unknown as TabManager
  const login = vi.fn(async () => ({ content: [{ type: 'text', text: 'submitted' }] }))
  const otherTool = vi.fn()
  vi.mocked(createSambaTools).mockReturnValue({
    tools: [
      { name: 'login', handler: login },
      { name: 'fill_secret', handler: otherTool },
      { name: 'run_js', handler: otherTool }
    ]
  } as unknown as ReturnType<typeof createSambaTools>)
  vi.mocked(inspectCardPage).mockResolvedValue(SIGNED_OUT)
  vi.mocked(observeSamsungLoginAlerts).mockResolvedValue({
    getOutcome: () => 'unknown',
    dispose: vi.fn()
  })
  return {
    options: {
      tabs,
      tabId: tab.id,
      vault: {} as VaultService,
      settings: { ...DEFAULT_SETTINGS, ...overrides },
      signal: new AbortController().signal
    },
    focus,
    login,
    otherTool,
    setUrl: (next) => (url = next)
  }
}

describe('card session restoration through existing KeyMaster login gates', () => {
  it('delegates only login and preserves every existing KeyMaster policy setting', async () => {
    const f = fixture({
      vaultAccessPolicy: 'never',
      vaultExcludedHosts: ['www.samsungcard.com'],
      vaultAutoSubmit: false,
      vaultKeepSignedIn: false
    })
    vi.mocked(inspectCardPage).mockResolvedValueOnce(SIGNED_OUT).mockResolvedValueOnce(SIGNED_IN)
    const result = await restoreCardSession(f.options)
    expect(result).toEqual({ state: 'signed_in', auth: 'signed_in' })
    expect(createSambaTools).toHaveBeenCalledOnce()
    const context = vi.mocked(createSambaTools).mock.calls[0][0]
    expect(context).toMatchObject({
      tabs: f.options.tabs,
      vault: f.options.vault,
      mode: 'guard',
      finalConfirm: false,
      vaultAccessPolicy: 'never',
      vaultExcludedHosts: ['www.samsungcard.com'],
      vaultAutoSubmit: false,
      vaultKeepSignedIn: false
    })
    expect(await context.confirm('synthetic blocked action')).toBe(false)
    expect(context).not.toHaveProperty('hyundaiAttempts')
    expect(context).not.toHaveProperty('lotteAttempts')
    expect(context).not.toHaveProperty('lotteKeypadAttempts')
    expect(f.login).toHaveBeenCalledOnce()
    expect(f.otherTool).not.toHaveBeenCalled()
  })

  it('does not run login in read-only mode or when already signed in', async () => {
    const f = fixture({ permissionMode: 'read_only' })
    expect(await restoreCardSession(f.options)).toEqual({ state: 'read_only', auth: 'signed_out' })
    vi.mocked(inspectCardPage).mockResolvedValue(SIGNED_IN)
    expect(await restoreCardSession(f.options)).toEqual({
      state: 'already_signed_in',
      auth: 'signed_in'
    })
    expect(createSambaTools).not.toHaveBeenCalled()
    expect(f.focus).not.toHaveBeenCalled()
  })

  it('does not start on an unsupported site or after cancellation', async () => {
    const f = fixture()
    f.setUrl('https://example.com/')
    expect((await restoreCardSession(f.options)).auth).toBe('unknown')
    f.setUrl('https://www.samsungcard.com/personal/login/UHPPCO0301M0.jsp')
    const controller = new AbortController()
    controller.abort()
    await restoreCardSession({ ...f.options, signal: controller.signal })
    expect(inspectCardPage).not.toHaveBeenCalled()
    expect(createSambaTools).not.toHaveBeenCalled()
  })

  it.each([
    ['locked: SYNTHETIC_PRIVATE_SECRET', 'vault_locked'],
    ['previous failed attempt: SYNTHETIC_PRIVATE_SECRET', 'login_unconfirmed'],
    ['needs_user: captcha SYNTHETIC_PRIVATE_SECRET', 'user_verification_required'],
    ['not found: SYNTHETIC_PRIVATE_SECRET', 'saved_account_unavailable'],
    ['refused: KeyMaster access policy is Never SYNTHETIC_PRIVATE_SECRET', 'policy_blocked'],
    ['error: SYNTHETIC_PRIVATE_SECRET', 'login_unconfirmed'],
    ['submitted: check the page for success or captcha/2FA', 'login_unconfirmed']
  ])('maps login output to fixed status without exposing details: %s', async (raw, state) => {
    const f = fixture()
    f.login.mockResolvedValue({ content: [{ type: 'text', text: raw }] })
    if (raw.startsWith('submitted:')) vi.useFakeTimers()
    const pending = restoreCardSession(f.options)
    if (raw.startsWith('submitted:')) await vi.advanceTimersByTimeAsync(25_001)
    const result = await pending
    expect(result).toEqual({ state, auth: 'signed_out' })
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_SECRET')
  })

  it.each([
    'refused: Lotte Card keypad login was already attempted; do not retry',
    'refused: Lotte Card login was already attempted; do not retry',
    'refused: Hyundai Card PIN was already attempted. Do not retry. Complete login yourself or update the saved PIN in KeyMaster.'
  ])('identifies only the actual persistent attempt-store rejection: %s', async (raw) => {
    const f = fixture()
    f.login.mockResolvedValue({ content: [{ type: 'text', text: raw }] })
    expect(await restoreCardSession(f.options)).toEqual({
      state: 'attempt_protected',
      auth: 'signed_out'
    })
  })

  it('distinguishes keypad verification failure from retry protection and returns only allowed diagnostics', async () => {
    const f = fixture()
    const prefix = 'refused: Lotte Card official keypad could not be verified; no submit or retry'
    f.login.mockResolvedValue({
      content: [
        { type: 'text', text: `${prefix} [stage=preflight_special; reason=label_mismatch]` }
      ]
    })
    expect(await restoreCardSession(f.options)).toEqual({
      state: 'keypad_unverified',
      auth: 'signed_out',
      stage: 'preflight_special',
      reason: 'label_mismatch'
    })
    f.login.mockResolvedValue({
      content: [{ type: 'text', text: `${prefix} [stage=private_secret; reason=private_password]` }]
    })
    const unknown = await restoreCardSession(f.options)
    expect(unknown).toEqual({ state: 'keypad_unverified', auth: 'signed_out' })
    expect(JSON.stringify(unknown)).not.toContain('private_')
  })

  it('does not confuse a safe no-retry input stop or submitted login with an existing attempt latch', async () => {
    const f = fixture()
    f.login.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: 'refused: Lotte Card official keypad input was not accepted; no submit or retry'
        }
      ]
    })
    expect(await restoreCardSession(f.options)).toEqual({
      state: 'input_not_accepted',
      auth: 'signed_out',
      stage: 'password_input'
    })
    f.login.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: 'needs_user: Lotte Card login was submitted once but is not confirmed; do not retry'
        }
      ]
    })
    expect(await restoreCardSession(f.options)).toEqual({
      state: 'user_verification_required',
      auth: 'signed_out'
    })
  })

  it('reports a scoped Samsung failure and disposes the observer without exposing dialog text', async () => {
    const f = fixture()
    const dispose = vi.fn()
    vi.mocked(observeSamsungLoginAlerts).mockResolvedValue({
      getOutcome: () => 'wrong_credentials',
      dispose
    })
    expect(await restoreCardSession(f.options)).toEqual({
      state: 'wrong_credentials',
      auth: 'signed_out'
    })
    expect(dispose).toHaveBeenCalledOnce()
    expect(f.login).toHaveBeenCalledOnce()
  })

  it('disposes the scoped observer when the underlying login throws', async () => {
    const f = fixture()
    const dispose = vi.fn()
    vi.mocked(observeSamsungLoginAlerts).mockResolvedValue({ getOutcome: () => 'unknown', dispose })
    f.login.mockRejectedValue(new Error('synthetic failure'))
    await expect(restoreCardSession(f.options)).rejects.toThrow('synthetic failure')
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('does not log in another saved site after navigation during the initial inspection', async () => {
    const f = fixture()
    vi.mocked(inspectCardPage).mockImplementationOnce(async () => {
      f.setUrl('https://unrelated.example/login')
      return { issuer: 'samsung_card', state: 'navigation_changed', auth: 'signed_out' }
    })
    const result = await restoreCardSession(f.options)
    expect(result.auth).not.toBe('signed_in')
    expect(createSambaTools).not.toHaveBeenCalled()
    expect(f.login).not.toHaveBeenCalled()
  })

  it('does not reuse a signed-in observation when its tab changed during inspection', async () => {
    const f = fixture()
    vi.mocked(inspectCardPage).mockImplementationOnce(async () => {
      f.setUrl('https://www.lottecard.co.kr/app/LPMANAA_V200.lc')
      return { issuer: 'samsung_card', state: 'navigation_changed', auth: 'signed_in' }
    })
    const result = await restoreCardSession(f.options)
    expect(result.auth).not.toBe('signed_in')
    expect(createSambaTools).not.toHaveBeenCalled()
  })

  it('does not report success when post-login inspection detects same-issuer navigation', async () => {
    const f = fixture()
    vi.mocked(inspectCardPage).mockResolvedValueOnce(SIGNED_OUT).mockResolvedValueOnce({
      issuer: 'samsung_card',
      state: 'navigation_changed',
      auth: 'signed_in'
    })
    const result = await restoreCardSession(f.options)
    expect(result.auth).not.toBe('signed_in')
    expect(result.state).not.toBe('signed_in')
  })

  it('waits for delayed Samsung AJAX login across a same-issuer page transition without resubmitting', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const dispose = vi.fn()
    vi.mocked(observeSamsungLoginAlerts).mockResolvedValue({ getOutcome: () => 'unknown', dispose })
    f.login.mockResolvedValue({
      content: [{ type: 'text', text: 'submitted: check the page for success or captcha/2FA' }]
    })
    vi.mocked(inspectCardPage)
      .mockResolvedValueOnce(SIGNED_OUT)
      .mockResolvedValueOnce(SIGNED_OUT)
      .mockImplementationOnce(async () => {
        f.setUrl('https://www.samsungcard.com/personal/card/activity/UHPPRP0801M0.jsp')
        return { ...SIGNED_IN, state: 'navigation_changed' }
      })
      .mockResolvedValueOnce(SIGNED_IN)
    const pending = restoreCardSession(f.options)
    await vi.advanceTimersByTimeAsync(749)
    expect(dispose).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(752)
    expect(await pending).toEqual({ state: 'signed_in', auth: 'signed_in' })
    expect(f.login).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('keeps the alert observer until a delayed fixed error arrives', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let outcome: 'unknown' | 'security_program_required' = 'unknown'
    const dispose = vi.fn()
    vi.mocked(observeSamsungLoginAlerts).mockResolvedValue({ getOutcome: () => outcome, dispose })
    f.login.mockResolvedValue({
      content: [{ type: 'text', text: 'submitted: check the page for success or captcha/2FA' }]
    })
    const pending = restoreCardSession(f.options)
    await vi.advanceTimersByTimeAsync(1000)
    expect(dispose).not.toHaveBeenCalled()
    outcome = 'security_program_required'
    await vi.advanceTimersByTimeAsync(501)
    expect(await pending).toEqual({ state: 'security_program_required', auth: 'signed_out' })
    expect(f.login).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('stops waiting immediately on cancellation and disposes without a new login', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const abort = new AbortController()
    const dispose = vi.fn()
    vi.mocked(observeSamsungLoginAlerts).mockResolvedValue({ getOutcome: () => 'unknown', dispose })
    f.login.mockResolvedValue({
      content: [{ type: 'text', text: 'submitted: awaiting site response' }]
    })
    const pending = restoreCardSession({ ...f.options, signal: abort.signal })
    await vi.advanceTimersByTimeAsync(100)
    abort.abort()
    expect(await pending).toEqual({ state: 'cancelled', auth: 'unknown' })
    expect(f.login).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('never polls or accepts a signed-in observation from a different card after navigation', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const dispose = vi.fn()
    vi.mocked(observeSamsungLoginAlerts).mockResolvedValue({ getOutcome: () => 'unknown', dispose })
    f.login.mockResolvedValue({
      content: [{ type: 'text', text: 'submitted: awaiting site response' }]
    })
    const pending = restoreCardSession(f.options)
    await vi.advanceTimersByTimeAsync(100)
    const calls = vi.mocked(inspectCardPage).mock.calls.length
    f.setUrl('https://www.lottecard.co.kr/app/LPMCDAA_V100.lc')
    await vi.advanceTimersByTimeAsync(651)
    expect(await pending).toEqual({ state: 'navigation_changed', auth: 'unknown' })
    expect(inspectCardPage).toHaveBeenCalledTimes(calls)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('bounds a stalled post-submit inspector to 25 seconds and retains no secret error', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const dispose = vi.fn()
    vi.mocked(observeSamsungLoginAlerts).mockResolvedValue({ getOutcome: () => 'unknown', dispose })
    f.login.mockResolvedValue({
      content: [{ type: 'text', text: 'submitted: PRIVATE_LOGIN_RESPONSE' }]
    })
    vi.mocked(inspectCardPage)
      .mockResolvedValueOnce(SIGNED_OUT)
      .mockReturnValueOnce(new Promise(() => undefined))
    const pending = restoreCardSession(f.options)
    await vi.advanceTimersByTimeAsync(25_001)
    expect(await pending).toEqual({ state: 'login_unconfirmed', auth: 'signed_out' })
    expect(f.login).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('ends a stalled inspector when a new native error arrives instead of waiting the full deadline', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let outcome: 'unknown' | 'wrong_credentials' = 'unknown'
    const dispose = vi.fn()
    vi.mocked(observeSamsungLoginAlerts).mockResolvedValue({ getOutcome: () => outcome, dispose })
    f.login.mockResolvedValue({
      content: [{ type: 'text', text: 'submitted: awaiting site response' }]
    })
    vi.mocked(inspectCardPage)
      .mockResolvedValueOnce(SIGNED_OUT)
      .mockReturnValueOnce(new Promise(() => undefined))
    const pending = restoreCardSession(f.options)
    await vi.advanceTimersByTimeAsync(100)
    outcome = 'wrong_credentials'
    await vi.advanceTimersByTimeAsync(650)
    expect(await pending).toEqual({ state: 'wrong_credentials', auth: 'signed_out' })
    expect(f.login).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
  })
})

describe('read-only Lotte keypad status projection', () => {
  it('returns only the fixed state and reason, never input length, key characters, controls or mode', async () => {
    const f = fixture()
    f.setUrl('https://www.lottecard.co.kr/app/LPMANAA_V200.lc')
    const tab = f.options.tabs.get(f.options.tabId)!
    const read = vi.spyOn(pageBridge, 'lotteKeypad').mockResolvedValue({
      state: 'open',
      reason: 'label_mismatch',
      filled: 8,
      layout: 9,
      mode: 'special',
      openId: 30,
      removeId: 31,
      keys: [{ character: 'PRIVATE', id: 32, label: 'PRIVATE' }],
      controls: [{ mode: 'lower', id: 33 }]
    })
    expect(await inspectLotteKeypadStatus(tab)).toEqual({ state: 'open', reason: 'label_mismatch' })
    expect(read).toHaveBeenCalledOnce()
    expect(createSambaTools).not.toHaveBeenCalled()
  })

  it('rejects other issuers before requesting keypad data', async () => {
    const f = fixture()
    const read = vi.spyOn(pageBridge, 'lotteKeypad')
    expect(await inspectLotteKeypadStatus(f.options.tabs.get(f.options.tabId)!)).toEqual({
      state: 'unsupported'
    })
    expect(read).not.toHaveBeenCalled()
  })

  it('drops unrecognized diagnostic strings and suppresses thrown private errors', async () => {
    const f = fixture()
    f.setUrl('https://www.lottecard.co.kr/app/LPMANAA_V200.lc')
    const tab = f.options.tabs.get(f.options.tabId)!
    const read = vi.spyOn(pageBridge, 'lotteKeypad')
    read.mockResolvedValue({ state: 'open', reason: 'PRIVATE_SECRET' } as never)
    expect(await inspectLotteKeypadStatus(tab)).toEqual({ state: 'open' })
    read.mockResolvedValue({ state: 'PRIVATE_SECRET' } as never)
    expect(await inspectLotteKeypadStatus(tab)).toEqual({ state: 'unknown' })
    read.mockRejectedValue(new Error('PRIVATE_SECRET'))
    expect(await inspectLotteKeypadStatus(tab)).toEqual({ state: 'unknown' })
  })

  it('discards keypad diagnostics on navigation while reading', async () => {
    const f = fixture()
    f.setUrl('https://www.lottecard.co.kr/app/LPMANAA_V200.lc')
    vi.spyOn(pageBridge, 'lotteKeypad').mockImplementation(async () => {
      f.setUrl('https://unrelated.example/')
      return { state: 'signed_in' }
    })
    expect(await inspectLotteKeypadStatus(f.options.tabs.get(f.options.tabId)!)).toEqual({
      state: 'unknown'
    })
  })
})
