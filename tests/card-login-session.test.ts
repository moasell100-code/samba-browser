import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabManager } from '../src/main/browser/tab-manager'
import type { VaultService } from '../src/main/vault/service'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'
import { createSambaTools } from '../src/main/agent/tools'
import { inspectCardPage } from '../src/main/finance/card-page-diagnostics'
import { restoreCardSession } from '../src/main/finance/card-login-session'

vi.mock('../src/main/agent/tools', () => ({ createSambaTools: vi.fn() }))
vi.mock('../src/main/finance/card-page-diagnostics', async (load) => {
  const actual = await load<typeof import('../src/main/finance/card-page-diagnostics')>()
  return { ...actual, inspectCardPage: vi.fn() }
})

afterEach(() => vi.resetAllMocks())

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
    ['previous failed attempt: SYNTHETIC_PRIVATE_SECRET', 'attempt_protected'],
    ['needs_user: captcha SYNTHETIC_PRIVATE_SECRET', 'user_verification_required'],
    ['not found: SYNTHETIC_PRIVATE_SECRET', 'saved_account_unavailable'],
    ['refused: KeyMaster access policy is Never SYNTHETIC_PRIVATE_SECRET', 'policy_blocked'],
    ['error: SYNTHETIC_PRIVATE_SECRET', 'login_unconfirmed']
  ])('maps login output to fixed status without exposing details: %s', async (raw, state) => {
    const f = fixture()
    f.login.mockResolvedValue({ content: [{ type: 'text', text: raw }] })
    const result = await restoreCardSession(f.options)
    expect(result).toEqual({ state, auth: 'signed_out' })
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_SECRET')
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
})
