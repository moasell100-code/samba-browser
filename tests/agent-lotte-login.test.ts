import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../src/main/agent/tools'
import type { LotteAuthSnapshot } from '../src/shared/lotte-auth'

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
  pageBridge.focusLottePassword.mockResolvedValue({ state: 'keypad_required' })
})

describe('Lotte protected login agent integration', () => {
  it('diagnoses mandatory keypad without reading or filling a password', async () => {
    const f = fixture()
    expect(await f.call('login')).toContain('keypad_required')
    expect(f.vault.getSecretForFill).not.toHaveBeenCalled()
    expect(pageBridge.fillValue).not.toHaveBeenCalled()
    expect(pageBridge.pressLotteCharacter).not.toHaveBeenCalled()
    expect(pageBridge.submitLotteLogin).not.toHaveBeenCalled()
  })
  it('stops if the site changes to secure keypad after focusing', async () => {
    const f = fixture()
    pageBridge.lotteAuth.mockResolvedValue({ state: 'keyboard_ready', focused: false, filled: 0 })
    expect(await f.call('login')).toContain('keypad_required')
    expect(pageBridge.fillValue).toHaveBeenCalledWith(expect.anything(), 1, 'synthetic-account')
    expect(f.vault.getSecretForFill).not.toHaveBeenCalled()
    expect(pageBridge.pressLotteCharacter).not.toHaveBeenCalled()
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
