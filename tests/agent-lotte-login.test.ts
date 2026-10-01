import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../src/main/agent/tools'
import type { LotteAuthSnapshot } from '../src/shared/lotte-auth'
import type { LotteKeypadSnapshot } from '../src/shared/lotte-keypad'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, _description: string, _schema: unknown, handler: unknown) => ({
    name,
    handler
  }),
  createSdkMcpServer: (value: unknown) => value
}))
const { pageBridge } = vi.hoisted(() => ({
  pageBridge: {
    lotteAuth: vi.fn<() => Promise<LotteAuthSnapshot>>(),
    lotteKeypad: vi.fn<() => Promise<LotteKeypadSnapshot>>(),
    pressLotteKeypad: vi.fn(async () => true),
    focusLotteKeypadPassword: vi.fn(async () => true),
    submitLotteKeypad: vi.fn(async () => true),
    focusLottePassword: vi.fn<() => Promise<LotteAuthSnapshot>>(),
    findLoginFields: vi.fn(async () => ({
      stage: 'single',
      username: 1,
      password: 2,
      iframe: false
    })),
    fillValue: vi.fn(async () => 'ok'),
    pressLotteCharacter: vi.fn(async () => true),
    submitLotteLogin: vi.fn(async () => true),
    waitForLoad: vi.fn(async () => undefined)
  }
}))
vi.mock('../src/main/browser/page-bridge', () => ({ pageBridge }))
const { createSambaTools } = await import('../src/main/agent/tools')

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture() {
  const account = {
    id: 1,
    host: 'www.lottecard.co.kr',
    username: 'synthetic-account',
    label: 'unit-account',
    agentAccess: 'inherit',
    isDefault: true
  }
  const vault = {
    state: vi.fn(() => 'unlocked'),
    listAccounts: vi.fn(() => [account]),
    listItems: vi.fn(() => [{ id: 2, type: 'login', sections: [] }]),
    loginSecretRevision: vi.fn(() => 'opaque-revision'),
    getSecretForFill: vi.fn(() => null),
    ensureUnlockedByDevice: vi.fn(async () => true)
  }
  const tab = {
    id: 'unit-tab',
    profile: 'unit-profile',
    view: {
      webContents: {
        getURL: () => 'https://www.lottecard.co.kr/app/LPMANAA_V200.lc',
        isDestroyed: () => false
      }
    }
  }
  const attempts = {
    begin: vi.fn(() => true),
    failed: vi.fn(),
    succeeded: vi.fn(),
    clearSignedInProfile: vi.fn()
  }
  const context = {
    tabs: {
      active: () => tab,
      list: () => [],
      navigate: vi.fn(),
      takeDialogMessage: () => undefined
    },
    mode: 'full',
    dangerWords: [],
    finalConfirm: false,
    confirm: vi.fn(async () => true),
    tick: () => null,
    onStep: vi.fn(),
    vault,
    lotteAttempts: attempts,
    lotteKeypadAttempts: attempts,
    jobId: 'unit-job'
  } as unknown as ToolContext
  const tools = createSambaTools(context).tools
  const call = async (
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<string | undefined> =>
    (await tools.find((tool) => tool.name === name)!.handler(args, {})).content[0].text
  return { vault, attempts, call }
}

beforeEach(() => {
  vi.clearAllMocks()
  pageBridge.lotteAuth.mockResolvedValue({ state: 'keypad_required' })
  pageBridge.lotteKeypad.mockResolvedValue({ state: 'unknown' })
  pageBridge.focusLottePassword.mockResolvedValue({ state: 'keypad_required' })
})

describe('Lotte protected login agent integration', () => {
  it('inspects fixed state without credential access, field focus, or attempt-store changes', async () => {
    const f = fixture()
    pageBridge.lotteAuth.mockResolvedValue({ state: 'keyboard_ready', focused: false, filled: 7 })
    const raw = await f.call('inspect_card_login')
    expect(JSON.parse(raw!)).toEqual({
      issuer: 'lotte_card',
      state: 'keyboard_ready',
      passwordFocus: 'not_focused',
      passwordBuffer: 'nonempty',
      attemptProtection: 'unchanged'
    })
    expect(raw).not.toContain('filled')
    expect(f.vault.getSecretForFill).not.toHaveBeenCalled()
    expect(pageBridge.focusLottePassword).not.toHaveBeenCalled()
    expect(f.attempts.begin).not.toHaveBeenCalled()
    expect(f.attempts.clearSignedInProfile).not.toHaveBeenCalled()
  })
  it('probe refuses mandatory keypad without credentials, submit, or latch mutation', async () => {
    const f = fixture()
    expect(await f.call('probe_lotte_keyboard')).toContain('keypad_required')
    expect(f.vault.getSecretForFill).not.toHaveBeenCalled()
    expect(pageBridge.submitLotteLogin).not.toHaveBeenCalled()
    expect(f.attempts.begin).not.toHaveBeenCalled()
    expect(f.attempts.clearSignedInProfile).not.toHaveBeenCalled()
  })
  it('rejects an unverified official keypad without reading or filling a password', async () => {
    const f = fixture()
    expect(await f.call('login')).toContain('could not be verified')
    expect(f.vault.getSecretForFill).not.toHaveBeenCalled()
    expect(pageBridge.fillValue).not.toHaveBeenCalled()
    expect(pageBridge.pressLotteCharacter).not.toHaveBeenCalled()
    expect(pageBridge.submitLotteLogin).not.toHaveBeenCalled()
  })
  it('never falls back to unsupported native keyboard input when official keypad is unavailable', async () => {
    const f = fixture()
    pageBridge.lotteAuth.mockResolvedValue({ state: 'keyboard_ready', focused: false, filled: 0 })
    expect(await f.call('login')).toContain('could not be verified')
    expect(pageBridge.focusLottePassword).not.toHaveBeenCalled()
    expect(f.vault.getSecretForFill).not.toHaveBeenCalled()
    expect(pageBridge.pressLotteCharacter).not.toHaveBeenCalled()
  })
  it('official keypad probe is credential-free and cannot reset attempt protection', async () => {
    const f = fixture()
    expect(await f.call('probe_lotte_keypad')).toContain('not_ready')
    expect(f.vault.getSecretForFill).not.toHaveBeenCalled()
    expect(pageBridge.submitLotteKeypad).not.toHaveBeenCalled()
    expect(f.attempts.begin).not.toHaveBeenCalled()
    expect(f.attempts.clearSignedInProfile).not.toHaveBeenCalled()
  })
  it('public layout-only probe cannot read credentials, clear input or reset attempt protection', async () => {
    const f = fixture()
    expect(await f.call('probe_lotte_keypad_layouts')).toContain('initial_state')
    expect(f.vault.getSecretForFill).not.toHaveBeenCalled()
    expect(pageBridge.pressLotteKeypad).not.toHaveBeenCalled()
    expect(pageBridge.submitLotteKeypad).not.toHaveBeenCalled()
    expect(f.attempts.begin).not.toHaveBeenCalled()
    expect(f.attempts.clearSignedInProfile).not.toHaveBeenCalled()
  })
  it('focus-only probe cannot request credentials or enter any keys', async () => {
    const f = fixture()
    expect(await f.call('probe_lotte_keypad_focus')).toContain('not_ready')
    expect(f.vault.getSecretForFill).not.toHaveBeenCalled()
    expect(pageBridge.pressLotteKeypad).not.toHaveBeenCalled()
    expect(pageBridge.submitLotteKeypad).not.toHaveBeenCalled()
    expect(f.attempts.begin).not.toHaveBeenCalled()
  })
  it('reuses a verified signed-in session even when KeyMaster is locked', async () => {
    const f = fixture()
    f.vault.state.mockReturnValue('locked')
    pageBridge.lotteAuth.mockResolvedValue({ state: 'signed_in' })
    expect(await f.call('login')).toContain('already signed in')
    expect(f.vault.listItems).not.toHaveBeenCalled()
    expect(f.vault.getSecretForFill).not.toHaveBeenCalled()
  })
  it('refuses a generic fill_secret fallback before accessing credentials', async () => {
    const f = fixture()
    expect(await f.call('fill_secret', { elementId: 2, itemType: 'login' })).toContain(
      'dedicated login tool'
    )
    expect(f.vault.getSecretForFill).not.toHaveBeenCalled()
    expect(pageBridge.fillValue).not.toHaveBeenCalled()
  })
})
