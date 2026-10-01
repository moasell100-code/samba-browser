import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../src/main/agent/tools'
import type { HyundaiAuthSnapshot } from '../src/shared/hyundai-auth'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, _description: string, _schema: unknown, handler: unknown) => ({
    name,
    handler
  }),
  createSdkMcpServer: (value: unknown) => value
}))

const { pageBridge, runLogin } = vi.hoisted(() => ({
  runLogin: vi.fn(),
  pageBridge: {
    hyundaiAuth: vi.fn(),
    findLoginFields: vi.fn(async () => ({ stage: 'password', password: 2, username: 3 })),
    signedInHint: vi.fn(async () => ({ signedIn: false })),
    keypadSignals: vi.fn(async () => ({ url: '', text: '', digitButtons: 0, pinField: false })),
    fillValue: vi.fn(async () => 'ok'),
    textOf: vi.fn(async () => ''),
    pressOnce: vi.fn(async () => 'ok'),
    click: vi.fn(async () => 'ok'),
    type: vi.fn(async () => 'ok'),
    isSecretField: vi.fn(async () => true),
    waitForLoad: vi.fn(async () => undefined)
  }
}))
vi.mock('../src/main/browser/page-bridge', () => ({ pageBridge }))
vi.mock('../src/main/finance/hyundai-login', async (actual) => ({
  ...(await actual<typeof import('../src/main/finance/hyundai-login')>()),
  loginHyundaiCard: runLogin
}))

const { createSambaTools } = await import('../src/main/agent/tools')
const { secretKeypadGate } = await import('../src/main/agent/secret-page')

// Preserve inferred Vitest mock signatures in this synthetic test fixture.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture(
  options: {
    state?: 'locked' | 'unlocked'
    method?: string
    accountPolicy?: string
    policy?: ToolContext['vaultAccessPolicy']
    url?: string
    autoSubmit?: boolean
  } = {}
) {
  const account = {
    id: 1,
    host: 'hyundaicard.com',
    label: 'unit-account',
    username: 'synthetic-user',
    agentAccess: options.accountPolicy ?? 'inherit',
    isDefault: true
  }
  const items = [
    {
      id: 4,
      type: 'login',
      sections: [
        {
          key: 'main',
          fields: [{ key: 'login.method', kind: 'select', value: options.method ?? 'hyundai_pin' }]
        }
      ]
    }
  ]
  const vault = {
    state: vi.fn(() => options.state ?? 'unlocked'),
    listAccounts: vi.fn(() => [account]),
    listItems: vi.fn(() => items),
    loginSecretRevision: vi.fn(() => 'encrypted-field-revision'),
    getSecretForFill: vi.fn(() => Array.from({ length: 6 }, (_, index) => String(index)).join('')),
    getPaymentSecretForFill: vi.fn(),
    ensureUnlockedByDevice: vi.fn(async () => true)
  }
  const attempts = {
    begin: vi.fn(() => true),
    failed: vi.fn(),
    succeeded: vi.fn(),
    clearSignedInProfile: vi.fn()
  }
  const tab = {
    id: 'unit-tab',
    profile: 'unit-profile',
    view: {
      webContents: {
        getURL: () => options.url ?? 'https://www.hyundaicard.com/index.jsp',
        isDestroyed: () => false
      }
    }
  }
  const onStep = vi.fn()
  const captureFinance = vi.fn(async () => ({ captureId: 'synthetic-capture', previewOnly: true }))
  const context = {
    captureFinance,
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
    onStep,
    vault,
    hyundaiAttempts: attempts,
    vaultAccessPolicy: options.policy,
    vaultAutoSubmit: options.autoSubmit,
    jobId: 'unit-job'
  } as unknown as ToolContext
  const tools = createSambaTools(context).tools
  const call = async (
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<string | undefined> =>
    (await tools.find((tool) => tool.name === name)!.handler(args, {})).content[0].text
  return { call, vault, attempts, onStep, context, captureFinance }
}

beforeEach(() => {
  vi.clearAllMocks()
  secretKeypadGate.clear()
  pageBridge.hyundaiAuth.mockResolvedValue({
    state: 'pin_ready',
    inputId: 1,
    filled: 0
  } satisfies HyundaiAuthSnapshot)
  runLogin.mockImplementation(async (deps) => {
    deps.readSavedPin()
    return 'signed in: Hyundai Card session verified'
  })
})

describe('Hyundai login agent integration', () => {
  it('requires verified login before collecting tables after session expiry', async () => {
    const f = fixture()
    expect(await f.call('capture_finance_table')).toContain('login required')
    expect(f.captureFinance).not.toHaveBeenCalled()
    pageBridge.hyundaiAuth.mockResolvedValue({ state: 'signed_in' })
    expect(await f.call('capture_finance_table')).toContain('synthetic-capture')
    expect(f.captureFinance).toHaveBeenCalledOnce()
  })

  it('checks a verified Hyundai session before touching a locked or unconfigured vault', async () => {
    pageBridge.hyundaiAuth.mockResolvedValue({ state: 'signed_in' })
    const f = fixture({ state: 'locked', policy: 'never' })
    expect(await f.call('login')).toBe('already signed in')
    expect(f.vault.state).not.toHaveBeenCalled()
    expect(f.vault.listAccounts).not.toHaveBeenCalled()
    expect(f.vault.getSecretForFill).not.toHaveBeenCalled()
    expect(f.attempts.clearSignedInProfile).toHaveBeenCalledWith('unit-profile')
  })

  it('uses only login/value through the dedicated flow and never a generic field or payment credential', async () => {
    const f = fixture()
    const result = await f.call('login')
    expect(result).toContain('session verified')
    expect(runLogin).toHaveBeenCalledOnce()
    expect(f.vault.getSecretForFill).toHaveBeenCalledExactlyOnceWith(
      1,
      'login',
      'value',
      'unit-job'
    )
    expect(pageBridge.findLoginFields).not.toHaveBeenCalled()
    expect(pageBridge.fillValue).not.toHaveBeenCalled()
    expect(f.vault.getPaymentSecretForFill).not.toHaveBeenCalled()
    expect(JSON.stringify({ result, steps: f.onStep.mock.calls })).not.toContain(
      f.vault.getSecretForFill.mock.results[0].value
    )
  })

  it.each([{ state: 'locked' as const }, { policy: 'never' as const }, { accountPolicy: 'never' }])(
    'honors vault and account restrictions %o',
    async (settings) => {
      const f = fixture(settings)
      expect(await f.call('login')).toMatch(/locked|Never/)
      expect(runLogin).not.toHaveBeenCalled()
      expect(f.vault.getSecretForFill).not.toHaveBeenCalled()
    }
  )

  it('passes automatic submission off to the PIN flow', async () => {
    const f = fixture({ autoSubmit: false })
    await f.call('login')
    expect(runLogin.mock.calls[0][0].autoSubmit).toBe(false)
  })

  it.each(['login', 'password'])(
    'blocks fill_secret %s from bypassing the PIN flow',
    async (itemType) => {
      const f = fixture()
      expect(await f.call('fill_secret', { elementId: 1, itemType })).toContain('must use login')
      expect(f.vault.getSecretForFill).not.toHaveBeenCalled()
      expect(f.vault.getPaymentSecretForFill).not.toHaveBeenCalled()
      expect(pageBridge.fillValue).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['click', { elementId: 2 }],
    ['type', { elementId: 1, text: 'unit text' }],
    ['run_js', { code: 'return await page.click(2)' }]
  ] as const)('blocks model driven %s on the PIN screen', async (tool, args) => {
    const f = fixture()
    expect(await f.call(tool, args)).toContain('must use login')
    expect(pageBridge.click).not.toHaveBeenCalled()
    expect(pageBridge.type).not.toHaveBeenCalled()
  })

  it('does not fill an ordinary saved password into the simple PIN screen', async () => {
    const f = fixture({ method: 'password' })
    expect(await f.call('login')).toContain('save Hyundai Card simple PIN')
    expect(runLogin).not.toHaveBeenCalled()
    expect(pageBridge.fillValue).not.toHaveBeenCalled()
  })

  it('refuses a nondefault Hyundai port before reading vault credentials', async () => {
    const f = fixture({ url: 'https://hyundaicard.com:8443/index.jsp' })
    expect(await f.call('login')).toContain('exact secure')
    expect(f.vault.getSecretForFill).not.toHaveBeenCalled()
    expect(runLogin).not.toHaveBeenCalled()
  })

  it('never routes a saved PIN through generic login on another Hyundai subdomain', async () => {
    const f = fixture({ url: 'https://other.hyundaicard.com/login' })
    expect(await f.call('login')).toContain('must use login')
    expect(f.vault.getSecretForFill).not.toHaveBeenCalled()
    expect(pageBridge.fillValue).not.toHaveBeenCalled()
  })
})
