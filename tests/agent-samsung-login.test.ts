import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../src/main/agent/tools'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, _description: string, _schema: unknown, handler: unknown) => ({
    name,
    handler
  }),
  createSdkMcpServer: (value: unknown) => value
}))
const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  find: vi.fn(),
  fill: vi.fn(),
  hint: vi.fn(),
  snapshot: vi.fn(),
  hyundaiAuth: vi.fn(),
  lotteAuth: vi.fn()
}))
vi.mock('../src/main/finance/samsung-login-preparation', () => ({
  prepareSamsungIdLogin: mocks.prepare
}))
vi.mock('../src/main/browser/page-bridge', () => ({
  pageBridge: {
    findLoginFields: mocks.find,
    fillValue: mocks.fill,
    signedInHint: mocks.hint,
    snapshot: mocks.snapshot,
    hyundaiAuth: mocks.hyundaiAuth,
    lotteAuth: mocks.lotteAuth,
    waitForLoad: vi.fn(async () => {})
  }
}))

import { createSambaTools } from '../src/main/agent/tools'

const LOGIN = 'https://www.samsungcard.com/personal/login/UHPPCO0301M0.jsp'
const fields = { stage: 'password', username: 2, password: 3, submit: 4 }

// Preserve inferred mock signatures in the synthetic credential fixture.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture(
  options: {
    url?: string
    mode?: ToolContext['mode']
    locked?: boolean
    dialog?: string
    limit?: boolean
  } = {}
) {
  let url = options.url ?? LOGIN
  const account = {
    id: 1,
    host: 'samsungcard.com',
    label: 'unit',
    username: 'synthetic-user',
    agentAccess: 'inherit',
    isDefault: true
  }
  const vault = {
    state: () => (options.locked ? 'locked' : 'unlocked'),
    listAccounts: vi.fn(() => [account]),
    listItems: vi.fn(() => []),
    getSecretForFill: vi.fn(() => 'synthetic-secret'),
    ensureUnlockedByDevice: vi.fn(async () => !options.locked)
  }
  const tab = {
    id: 'card',
    profile: 'unit',
    view: { webContents: { getURL: () => url, isDestroyed: () => false } }
  }
  const navigate = vi.fn(async (_id: string, next: string) => {
    url = next
  })
  let queuedDialog = options.dialog
  const takeDialog = vi.fn(() => {
    const message = queuedDialog
    queuedDialog = undefined
    return message
  })
  const tick = vi.fn(() => (options.limit ? 'limit reached' : null))
  const context = {
    tabs: { active: () => tab, list: () => [], navigate, takeDialogMessage: takeDialog },
    vault,
    mode: options.mode ?? 'full',
    dangerWords: [],
    finalConfirm: false,
    confirm: vi.fn(async () => true),
    tick,
    onStep: vi.fn(),
    vaultAutoSubmit: false,
    hyundaiAttempts: { clearSignedInProfile: vi.fn() },
    lotteAttempts: { clearSignedInProfile: vi.fn() },
    lotteKeypadAttempts: { clearSignedInProfile: vi.fn() }
  } as unknown as ToolContext
  const login = createSambaTools(context).tools.find((tool) => tool.name === 'login')!
  const call = async (): Promise<string | undefined> =>
    (await login.handler({}, {})).content[0].text
  return { call, vault, tab, navigate, takeDialog, tick }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.prepare.mockResolvedValue({ state: 'ready', tab: 'id_tab' })
  mocks.find.mockResolvedValue(fields)
  mocks.fill.mockResolvedValue('ok')
  mocks.hint.mockResolvedValue({ signedIn: false })
  mocks.snapshot.mockResolvedValue({ elements: [] })
  mocks.hyundaiAuth.mockResolvedValue({ state: 'signed_in' })
  mocks.lotteAuth.mockResolvedValue({ state: 'signed_in' })
})

describe('Samsung login ID-tab preparation integration', () => {
  it('switches only after the generic reader found no visible fields, then re-detects', async () => {
    mocks.find.mockResolvedValueOnce({ stage: 'none' })
    const f = fixture()
    const output = await f.call()
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(f.tab)
    expect(mocks.find).toHaveBeenCalledTimes(2)
    expect(mocks.fill).toHaveBeenNthCalledWith(1, f.tab, 2, 'synthetic-user')
    expect(mocks.fill).toHaveBeenNthCalledWith(2, f.tab, 3, 'synthetic-secret')
    expect(output).toMatch(/^filled:/)
    expect(output).not.toContain('synthetic-secret')
  })

  it('leaves an already available ID form alone', async () => {
    const f = fixture()
    expect(await f.call()).toMatch(/^filled:/)
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it('does not prepare or retrieve secrets in read-only or locked mode', async () => {
    for (const opts of [{ mode: 'read_only' as const }, { locked: true }]) {
      const f = fixture(opts)
      await f.call()
      expect(f.vault.getSecretForFill).not.toHaveBeenCalled()
    }
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.fill).not.toHaveBeenCalled()
  })

  it('does not fill when the public ID tab or form cannot be verified', async () => {
    mocks.find.mockResolvedValue({ stage: 'none' })
    mocks.prepare.mockResolvedValue({ state: 'tab_ambiguous', tab: 'multiple' })
    const f = fixture()
    expect(await f.call()).toMatch(/^fields not found:/)
    expect(f.vault.getSecretForFill).not.toHaveBeenCalled()
    expect(mocks.fill).not.toHaveBeenCalled()
  })

  it('also prepares after the existing fallback navigates to Samsung login', async () => {
    mocks.find.mockResolvedValueOnce({ stage: 'none' }).mockResolvedValueOnce({ stage: 'none' })
    mocks.prepare.mockResolvedValueOnce({ state: 'unsupported', tab: 'none' })
    const f = fixture({ url: 'https://www.samsungcard.com/' })
    expect(await f.call()).toMatch(/^filled:/)
    expect(f.navigate).toHaveBeenCalledWith('card', LOGIN)
    expect(mocks.prepare).toHaveBeenCalledTimes(2)
  })

  it.each([
    LOGIN,
    'https://www.hyundaicard.com/cpa/cb/CPACB0101_01.hc',
    'https://www.lottecard.co.kr/app/LPMCDAA_V100.lc'
  ])('does not attach or retain native login dialogs for %s', async (url) => {
    const f = fixture({ url, dialog: 'PRIVATE ACCOUNT LOGIN ALERT' })
    expect(await f.call()).not.toContain('PRIVATE ACCOUNT')
    expect(f.takeDialog).toHaveBeenCalledOnce()
    expect(f.takeDialog()).toBeUndefined()
  })

  it('clears card dialogs on exceptions and returns a fixed error only', async () => {
    mocks.find.mockRejectedValueOnce(new Error('PRIVATE PASSWORD ERROR'))
    const f = fixture({ dialog: 'PRIVATE ACCOUNT LOGIN ALERT' })
    expect(await f.call()).toBe('error: card login unavailable')
    expect(f.takeDialog).toHaveBeenCalledOnce()
    expect(f.takeDialog()).toBeUndefined()
  })

  it('clears card dialogs even when the tool-call limit rejects the login', async () => {
    const f = fixture({ limit: true, dialog: 'PRIVATE ACCOUNT LOGIN ALERT' })
    expect(await f.call()).toBe('limit reached')
    expect(mocks.find).not.toHaveBeenCalled()
    expect(f.takeDialog).toHaveBeenCalledOnce()
    expect(f.takeDialog()).toBeUndefined()
  })

  it('preserves ordinary site dialog notices', async () => {
    const f = fixture({
      url: 'https://example.test/login',
      mode: 'read_only',
      dialog: 'Ordinary notice'
    })
    expect(await f.call()).toBe('page dialog: "Ordinary notice"\nrefused: read-only mode')
  })
})
