import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tab, TabManager } from '../src/main/browser/tab-manager'
import type { VaultService } from '../src/main/vault/service'
import { parseSettings } from '../src/shared/settings'
import type { CardDailyFile } from '../src/main/finance/card-daily-store'
import type { CardDailyStatus } from '../src/shared/card-daily'

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  restore: vi.fn(),
  sync: vi.fn(),
  configure: vi.fn(),
  report: vi.fn(),
  reconcile: vi.fn(),
  recover: vi.fn(async () => true),
  realStore: false,
  record: undefined as CardDailyFile | undefined
}))
vi.mock('../src/main/finance/card-agent-sync', () => ({ createCardAgentSync: mocks.configure }))
vi.mock('../src/main/finance/card-login-session', () => ({ restoreCardSession: mocks.restore }))
vi.mock('../src/main/finance/card-schedule-report', () => ({ reportCardSchedule: mocks.report }))
vi.mock('../src/main/finance/card-reconciliation-sync', () => ({
  reconcileKnownCards: mocks.reconcile
}))
vi.mock('../src/main/finance/card-coverage-sync', () => ({ recoverCardCoverage: mocks.recover }))
vi.mock('../src/main/finance/card-page-diagnostics', () => ({
  CARD_HISTORY_URLS: {
    hyundai_card: 'https://www.hyundaicard.com/history',
    samsung_card: 'https://www.samsungcard.com/history',
    lotte_card: 'https://www.lottecard.co.kr/history'
  },
  issuerForCardUrl: (url: string): string | null =>
    url.startsWith('https://www.hyundaicard.com/')
      ? 'hyundai_card'
      : url.startsWith('https://www.samsungcard.com/')
        ? 'samsung_card'
        : url.startsWith('https://www.lottecard.co.kr/')
          ? 'lotte_card'
          : null,
  inspectCardPage: mocks.inspect
}))
vi.mock('../src/main/finance/card-daily-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/finance/card-daily-store')>()
  return {
    ...actual,
    FileCardDailyStore: class {
      private readonly store: InstanceType<typeof actual.FileCardDailyStore> | undefined
      constructor(file: string) {
        if (mocks.realStore) this.store = new actual.FileCardDailyStore(file)
      }
      read(): CardDailyFile {
        return (
          this.store?.read() ??
          actual.cardDailyFileSchema.parse(
            structuredClone(mocks.record ?? { version: 1, gapDays: 0, lastCovered: {} })
          )
        )
      }
      write(record: CardDailyFile): void {
        const safe = actual.cardDailyFileSchema.parse(record)
        this.store?.write(safe)
        mocks.record = structuredClone(safe)
      }
    }
  }
})
import { createCardDailyRuntime } from '../src/main/finance/card-daily-runtime'
import { FileCardDailyStore } from '../src/main/finance/card-daily-store'
import { issuerForCardUrl } from '../src/main/finance/card-page-diagnostics'

function setup(
  options: { initialNavigationRace?: boolean; failBlank?: boolean; stateFile?: string } = {}
): {
  runtime: ReturnType<typeof createCardDailyRuntime>
  settings: ReturnType<typeof parseSettings>
  tabs: {
    create: ReturnType<typeof vi.fn>
    get: (id: string) => Tab | undefined
    active: () => Tab | undefined
    focusTarget: ReturnType<typeof vi.fn>
    agentTarget: () => Tab | undefined
  }
  vault: {
    state: ReturnType<typeof vi.fn>
    ensureUnlockedByDevice: ReturnType<typeof vi.fn>
    holdAutoLock: ReturnType<typeof vi.fn>
  }
  statuses: CardDailyStatus[]
  release: ReturnType<typeof vi.fn>
  navigate(url: string): void
} {
  const settings = parseSettings({
    financeDailyEnabled: true,
    financeDailyHourKst: 9,
    financeCollectorTransport: 'server-ssh'
  })
  const all = new Map<string, Tab>()
  let active = 'user'
  const makeTab = (id: string, url: string): Tab => {
    let initialBlankPending = !!options.initialNavigationRace && id !== 'user'
    return {
      id,
      profile: 'default',
      view: {
        webContents: {
          getURL: () => url,
          isDestroyed: () => false,
          isLoading: vi.fn().mockReturnValue(false),
          loadURL: vi.fn(async (next: string) => {
            url = next
            if (next === 'about:blank') {
              if (options.failBlank)
                throw Object.assign(new Error('PRIVATE-SITE-ERROR'), {
                  code: 'ERR_ABORTED',
                  errno: -3
                })
              initialBlankPending = false
            } else if (initialBlankPending) {
              throw Object.assign(new Error('PRIVATE-NAVIGATION-ERROR'), {
                code: 'ERR_ABORTED',
                errno: -3
              })
            }
          }),
          stop: vi.fn()
        }
      }
    } as unknown as Tab
  }
  all.set('user', makeTab('user', 'https://example.test/untouched'))
  const tabs = {
    create: vi.fn((options: { url: string }) => {
      const id = `dedicated-${all.size}`
      const tab = makeTab(id, options.url)
      all.set(id, tab)
      active = id
      return tab
    }),
    get: (id: string) => all.get(id),
    active: () => all.get(active),
    focusTarget: vi.fn((id: string) => {
      active = id
    }),
    agentTarget: () => all.get(active)
  }
  const vault = {
    state: vi.fn().mockReturnValue('unlocked'),
    ensureUnlockedByDevice: vi.fn().mockResolvedValue(true),
    holdAutoLock: vi.fn().mockReturnValue(vi.fn())
  }
  const release = vi.fn()
  const statuses: CardDailyStatus[] = []
  const runtime = createCardDailyRuntime({
    tabs: tabs as unknown as TabManager,
    vault: vault as unknown as VaultService,
    agent: { tryAcquireCardAutomation: () => release, isRunning: () => false },
    settings: () => settings,
    stateFile: options.stateFile ?? 'not-used',
    onChanged: (status) => statuses.push(status)
  })
  return {
    runtime,
    settings,
    tabs,
    vault,
    statuses,
    release,
    navigate: (url) => {
      void all.get(active)!.view.webContents.loadURL(url)
    }
  }
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-05T00:00:00Z'))
  mocks.record = undefined
  mocks.realStore = false
  mocks.configure.mockResolvedValue(mocks.sync)
  mocks.inspect.mockImplementation(async (tab: Tab) => ({
    issuer: issuerForCardUrl(tab.view.webContents.getURL()),
    auth: 'signed_in',
    state: 'ready'
  }))
  mocks.restore.mockResolvedValue({ state: 'signed_in', auth: 'signed_in' })
  mocks.sync.mockImplementation(async (tab: Tab) => ({
    ok: true,
    issuer: issuerForCardUrl(tab.view.webContents.getURL()),
    approvalComplete: true,
    complete: false,
    totalRows: 3,
    insertedRows: 1,
    updatedRows: 0,
    reviewRows: 0,
    secret: 'MUST_NOT_LEAK'
  }))
  mocks.report.mockResolvedValue(true)
  mocks.reconcile.mockResolvedValue({
    state: 'no_work',
    checkedDays: 0,
    reviewRows: 0,
    updatedRows: 0
  })
})
afterEach(() => vi.useRealTimers())

describe('deterministic daily card runtime', () => {
  it('persists all issuer receipts and 31-day checks to disk and restores them without repeating a run', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'card-daily-runtime-'))
    const stateFile = join(directory, 'runs.json')
    mocks.realStore = true
    mocks.recover.mockResolvedValue(false)
    mocks.sync.mockImplementation(async (tab: Tab) => ({
      ok: true,
      issuer: issuerForCardUrl(tab.view.webContents.getURL()),
      approvalComplete: true,
      cancellationComplete: issuerForCardUrl(tab.view.webContents.getURL()) === 'samsung_card',
      complete: issuerForCardUrl(tab.view.webContents.getURL()) === 'samsung_card',
      totalRows: 3,
      insertedRows: 1,
      updatedRows: 0,
      reviewRows: 0
    }))
    mocks.reconcile.mockResolvedValue({
      state: 'checked',
      checkedDays: 31,
      reviewRows: 0,
      updatedRows: 2
    })
    const first = setup({ stateFile })
    let restarted: ReturnType<typeof setup> | undefined
    try {
      await first.runtime.tick()
      expect(mocks.sync).toHaveBeenCalledTimes(3)
      expect(mocks.reconcile).toHaveBeenCalledTimes(3)
      expect(mocks.recover).toHaveBeenCalledTimes(3)
      expect(first.runtime.status().reason).toBeUndefined()
      const store = new FileCardDailyStore(stateFile)
      const persisted = store.read()
      expect(persisted.run?.finishedAt).toBeDefined()
      expect(persisted.run?.results.map((row) => row.cancellationComplete)).toEqual([
        false,
        true,
        false
      ])
      expect(
        persisted.run?.results.every(
          (row) => row.state === 'saved' && row.reconciliation?.checkedDays === 31
        )
      ).toBe(true)
      expect(
        first.statuses
          .filter((status) => status.phase === 'running')
          .some((status) => status.results.filter((row) => row.state === 'saved').length === 2)
      ).toBe(true)
      const savedFile = readFileSync(stateFile, 'utf8')
      const invalid = structuredClone(persisted)
      invalid.run!.results[0].reconciliation!.checkedDays = 32
      expect(() => store.write(invalid)).toThrow()
      expect(readFileSync(stateFile, 'utf8')).toBe(savedFile)
      first.runtime.dispose()
      mocks.record = undefined
      restarted = setup({ stateFile })
      expect(restarted.runtime.status().results).toEqual(persisted.run?.results)
      await restarted.runtime.tick()
      expect(mocks.sync).toHaveBeenCalledTimes(3)
      expect(mocks.reconcile).toHaveBeenCalledTimes(3)
      expect(restarted.runtime.status().reason).toBeUndefined()
    } finally {
      first.runtime.dispose()
      restarted?.runtime.dispose()
      rmSync(directory, { recursive: true })
    }
  })
  it('waits for the committed history document after an earlier blank load resolves its promise', async () => {
    const f = setup()
    const create = f.tabs.create.getMockImplementation()!
    f.tabs.create.mockImplementation((options: { url: string }) => {
      const tab = create(options) as Tab
      const load = vi.mocked(tab.view.webContents.loadURL).getMockImplementation()!
      vi.mocked(tab.view.webContents.loadURL).mockImplementation(async (url, options) => {
        if (url === 'about:blank') return load(url, options)
        vi.mocked(tab.view.webContents.isLoading).mockReturnValue(true)
        setTimeout(() => {
          void load(url, options)
        }, 500)
        setTimeout(() => vi.mocked(tab.view.webContents.isLoading).mockReturnValue(false), 1_000)
        // A stale blank-document finish resolves before this navigation commits.
      })
      return tab
    })
    const done = f.runtime.tick()
    await vi.advanceTimersByTimeAsync(750)
    expect(mocks.inspect).not.toHaveBeenCalled()
    expect(mocks.restore).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_250)
    await done
    expect(mocks.sync).toHaveBeenCalledTimes(3)
    expect(mocks.restore).not.toHaveBeenCalled()
    for (const entry of f.tabs.create.mock.results) {
      const tab = entry.value as Tab
      expect(vi.mocked(tab.view.webContents.loadURL).mock.calls.map(([url]) => url)).toEqual([
        'about:blank',
        expect.stringContaining('/history')
      ])
    }
    f.runtime.dispose()
  })
  it.each(['external', 'removed', 'aborted'] as const)(
    'stops pending document initialization on %s without login',
    async (kind) => {
      const f = setup()
      const create = f.tabs.create.getMockImplementation()!
      f.tabs.create.mockImplementation((options: { url: string }) => {
        const tab = create(options) as Tab
        vi.mocked(tab.view.webContents.loadURL).mockImplementation(async () => {
          // Keep the actual document blank after a stale load promise resolves.
        })
        setTimeout(() => {
          if (kind === 'external') tab.view.webContents.getURL = () => 'https://untrusted.test/'
          if (kind === 'removed') tab.profile = 'replaced-profile'
          if (kind === 'aborted') f.settings.financeDailyEnabled = false
        }, 500)
        return tab
      })
      const done = f.runtime.tick()
      await vi.advanceTimersByTimeAsync(2_000)
      await done
      expect(mocks.restore).not.toHaveBeenCalled()
      expect(mocks.inspect).not.toHaveBeenCalled()
      expect(mocks.sync).not.toHaveBeenCalled()
      expect(f.runtime.status().results[0]).toMatchObject({
        stage: 'verify_history_navigation',
        loginAttempted: false,
        state: 'failed'
      })
      f.runtime.dispose()
    }
  )
  it('times out a resolved navigation that never leaves the blank document without another request', async () => {
    const f = setup()
    const create = f.tabs.create.getMockImplementation()!
    f.tabs.create.mockImplementation((options: { url: string }) => {
      const tab = create(options) as Tab
      const load = vi.mocked(tab.view.webContents.loadURL).getMockImplementation()!
      vi.mocked(tab.view.webContents.loadURL).mockImplementation(async (url, options) => {
        if (url === 'about:blank') return load(url, options)
      })
      return tab
    })
    const done = f.runtime.tick()
    await vi.advanceTimersByTimeAsync(60_000)
    await done
    expect(mocks.restore).not.toHaveBeenCalled()
    expect(f.runtime.status().results[0]).toMatchObject({
      stage: 'verify_history_navigation',
      reason: 'timeout',
      loginAttempted: false,
      navigationTrace: {
        loadResult: 'resolved',
        observedOrigin: 'about_blank',
        errorName: 'Error',
        errorHint: 'unknown'
      }
    })
    f.runtime.dispose()
  })
  it('records a non-thenable loadURL result without starting login or leaking the page', async () => {
    const f = setup()
    const create = f.tabs.create.getMockImplementation()!
    f.tabs.create.mockImplementation((options: { url: string }) => {
      const tab = create(options) as Tab
      const load = vi.mocked(tab.view.webContents.loadURL).getMockImplementation()!
      vi.mocked(tab.view.webContents.loadURL).mockImplementation((url, options) => {
        if (url === 'about:blank') return load(url, options)
        return undefined as unknown as Promise<void>
      })
      return tab
    })
    await f.runtime.tick()
    expect(mocks.restore).not.toHaveBeenCalled()
    expect(f.runtime.status().results[0]).toMatchObject({
      stage: 'open_history',
      loginAttempted: false,
      navigationTrace: { loadResult: 'non_thenable', observedOrigin: 'about_blank' }
    })
    f.runtime.dispose()
  })
  it('records allowlisted navigation errors at open_history with zero login attempts', async () => {
    const f = setup()
    const create = f.tabs.create.getMockImplementation()!
    f.tabs.create.mockImplementation((options: { url: string }) => {
      const tab = create(options) as Tab
      const load = vi.mocked(tab.view.webContents.loadURL).getMockImplementation()!
      vi.mocked(tab.view.webContents.loadURL).mockImplementation(async (url, options) => {
        if (url !== 'about:blank')
          throw new Error(
            "net::ERR_CERT_AUTHORITY_INVALID (-202) loading 'https://PRIVATE/?account=SECRET'"
          )
        return load(url, options)
      })
      return tab
    })
    await f.runtime.tick()
    expect(mocks.restore).not.toHaveBeenCalled()
    expect(mocks.sync).not.toHaveBeenCalled()
    expect(
      f.runtime
        .status()
        .results.every(
          (row) =>
            row.stage === 'open_history' &&
            row.loginAttempted === false &&
            row.navigationFailure?.category === 'tls' &&
            row.navigationFailure?.code === 'ERR_CERT_AUTHORITY_INVALID'
        )
    ).toBe(true)
    expect(JSON.stringify(f.statuses)).not.toMatch(/PRIVATE|SECRET/)
    f.runtime.dispose()
  })
  it('settles the newly created blank document before issuing a history navigation', async () => {
    const f = setup({ initialNavigationRace: true })
    await f.runtime.tick()
    expect(mocks.sync).toHaveBeenCalledTimes(3)
    for (const result of f.tabs.create.mock.results) {
      const tab = result.value as Tab
      const calls = vi.mocked(tab.view.webContents.loadURL).mock.calls
      expect(calls.map(([url]) => url)).toEqual([
        'about:blank',
        expect.stringMatching(/^https:\/\/www\./)
      ])
    }
    expect(mocks.restore).not.toHaveBeenCalled()
    f.runtime.dispose()
  })
  it('persists fixed failure stage and proof that login was never invoked without exposing raw errors', async () => {
    const f = setup({ failBlank: true })
    await f.runtime.tick()
    expect(mocks.restore).not.toHaveBeenCalled()
    expect(mocks.sync).not.toHaveBeenCalled()
    expect(
      f.runtime
        .status()
        .results.every(
          (row) =>
            row.stage === 'prepare_tab' &&
            row.loginAttempted === false &&
            row.failureKind === 'navigation_aborted'
        )
    ).toBe(true)
    expect(JSON.stringify(f.statuses)).not.toContain('PRIVATE')
    expect(JSON.stringify(mocks.report.mock.calls)).not.toContain('PRIVATE')
    expect(mocks.record?.loginBlocked).toEqual({
      hyundai_card: false,
      samsung_card: false,
      lotte_card: false
    })
    f.runtime.dispose()
  })
  it('does not remove a pre-existing credential block after a proven no-login navigation failure', async () => {
    mocks.record = { version: 1, gapDays: 0, lastCovered: {}, loginBlocked: { samsung_card: true } }
    const f = setup({ failBlank: true })
    await f.runtime.tick()
    expect(mocks.record?.loginBlocked).toEqual({
      hyundai_card: false,
      samsung_card: true,
      lotte_card: false
    })
    expect(mocks.restore).not.toHaveBeenCalled()
    f.runtime.dispose()
  })
  it('retains a prior credential block across days and only clears it after a verified saved session', async () => {
    mocks.record = { version: 1, gapDays: 0, lastCovered: {}, loginBlocked: { samsung_card: true } }
    const f = setup()
    mocks.inspect.mockImplementation(async (tab: Tab) => ({
      issuer: issuerForCardUrl(tab.view.webContents.getURL()),
      auth:
        issuerForCardUrl(tab.view.webContents.getURL()) === 'samsung_card'
          ? 'signed_out'
          : 'signed_in'
    }))
    await f.runtime.tick()
    expect(mocks.restore).not.toHaveBeenCalled()
    expect(f.runtime.status().results[1]).toMatchObject({
      state: 'needs_login',
      reason: 'attempt_protected'
    })
    expect(mocks.record.loginBlocked?.samsung_card).toBe(true)
    vi.setSystemTime(new Date('2026-10-06T00:00:00Z'))
    mocks.inspect.mockImplementation(async (tab: Tab) => ({
      issuer: issuerForCardUrl(tab.view.webContents.getURL()),
      auth: 'signed_in'
    }))
    await f.runtime.tick()
    expect(mocks.restore).not.toHaveBeenCalled()
    expect(mocks.record.loginBlocked?.samsung_card).toBe(false)
    f.runtime.dispose()
  })
  it('does not retain a credential block when only saving fails after verified sign-in', async () => {
    const f = setup()
    mocks.sync.mockRejectedValue(new Error('PRIVATE-SAVE-ERROR'))
    await f.runtime.tick()
    expect(mocks.record?.loginBlocked).toEqual({
      hyundai_card: false,
      samsung_card: false,
      lotte_card: false
    })
    expect(f.runtime.status().results.every((row) => row.state === 'failed')).toBe(true)
    expect(JSON.stringify(f.statuses)).not.toContain('verifiedSignedIn')
    f.runtime.dispose()
  })
  it('uses dedicated tabs and existing signed-in sessions sequentially, with no model/login call', async () => {
    const f = setup()
    await f.runtime.tick()
    expect(mocks.restore).not.toHaveBeenCalled()
    expect(
      mocks.sync.mock.calls.map(([tab]) => issuerForCardUrl(tab.view.webContents.getURL()))
    ).toEqual(['hyundai_card', 'samsung_card', 'lotte_card'])
    expect(f.tabs.create).toHaveBeenCalledTimes(3)
    expect(f.tabs.get('user')!.view.webContents.loadURL).not.toHaveBeenCalled()
    expect(f.tabs.active()?.id).toBe('user')
    expect(f.release).toHaveBeenCalledOnce()
    expect(JSON.stringify(f.statuses)).not.toContain('MUST_NOT_LEAK')
    expect(JSON.stringify(mocks.report.mock.calls)).not.toContain('MUST_NOT_LEAK')
    f.runtime.dispose()
  })
  it('restores a signed-out issuer only once and preserves failed-attempt protection', async () => {
    const f = setup()
    mocks.inspect.mockImplementation(async (tab: Tab) => ({
      issuer: issuerForCardUrl(tab.view.webContents.getURL()),
      auth: 'signed_out'
    }))
    mocks.restore.mockResolvedValue({ state: 'attempt_protected', auth: 'signed_out' })
    await f.runtime.tick()
    await f.runtime.tick()
    expect(mocks.restore).toHaveBeenCalledTimes(3)
    expect(mocks.sync).not.toHaveBeenCalled()
    expect(f.runtime.status().results.every((row) => row.reason === 'attempt_protected')).toBe(true)
    f.runtime.dispose()
  })
  it('waits for delayed signed-in DOM and never submits login during that initialization', async () => {
    const f = setup()
    mocks.inspect.mockResolvedValueOnce({ issuer: 'hyundai_card', auth: 'unknown' })
    const done = f.runtime.tick()
    await vi.advanceTimersByTimeAsync(250)
    await done
    expect(mocks.restore).not.toHaveBeenCalled()
    expect(mocks.sync).toHaveBeenCalledTimes(3)
    f.runtime.dispose()
  })
  it('restores unknown auth only at an exact official entry and verifies sign-in before collection', async () => {
    const f = setup()
    const restored = new Set<string>()
    mocks.inspect.mockImplementation(async (tab: Tab) => ({
      issuer: issuerForCardUrl(tab.view.webContents.getURL()),
      auth: restored.has(tab.id) ? 'signed_in' : 'unknown',
      state: restored.has(tab.id) ? 'ready' : 'unknown'
    }))
    mocks.restore.mockImplementation(async ({ tabId }: { tabId: string }) => {
      restored.add(tabId)
      return { state: 'signed_in', auth: 'signed_in' }
    })
    const done = f.runtime.tick()
    await vi.advanceTimersByTimeAsync(30_000)
    await done
    expect(mocks.restore).toHaveBeenCalledTimes(3)
    expect(mocks.sync).toHaveBeenCalledTimes(3)
    expect(f.runtime.status().results.every((row) => row.state === 'saved')).toBe(true)
    f.runtime.dispose()
  })
  it.each(['allowed', 'prior_block', 'wrong_path', 'external_origin'] as const)(
    'handles Samsung QR login return parameters with a fixed entry for %s',
    async (scenario) => {
      if (scenario === 'prior_block')
        mocks.record = {
          version: 1,
          gapDays: 0,
          lastCovered: {},
          loginBlocked: { samsung_card: true }
        }
      const f = setup()
      const canonical = 'https://www.samsungcard.com/personal/login/UHPPCO0301M0.jsp'
      const redirected =
        scenario === 'wrong_path'
          ? 'https://www.samsungcard.com/unverified-login?returnUrl=PRIVATE'
          : scenario === 'external_origin'
            ? 'https://untrusted.test/personal/login/UHPPCO0301M0.jsp?returnUrl=PRIVATE'
            : `${canonical}?returnUrl=PRIVATE-REDIRECT-TOKEN`
      let restored = false
      const create = f.tabs.create.getMockImplementation()!
      f.tabs.create.mockImplementation((options: { url: string }) => {
        const tab = create(options) as Tab
        const load = vi.mocked(tab.view.webContents.loadURL).getMockImplementation()!
        vi.mocked(tab.view.webContents.loadURL).mockImplementation(async (url, options) => {
          return load(
            !restored && url === 'https://www.samsungcard.com/history' ? redirected : url,
            options
          )
        })
        return tab
      })
      mocks.inspect.mockImplementation(async (tab: Tab) => {
        const issuer = issuerForCardUrl(tab.view.webContents.getURL())
        const unknown = issuer === 'samsung_card' && !restored
        return {
          issuer,
          auth: unknown ? 'unknown' : 'signed_in',
          state: unknown ? 'unknown' : 'ready'
        }
      })
      mocks.restore.mockImplementation(async ({ tabId }: { tabId: string }) => {
        expect(f.tabs.get(tabId)!.view.webContents.getURL()).toBe(canonical)
        restored = true
        return { auth: 'signed_in', state: 'signed_in' }
      })
      const done = f.runtime.tick()
      await vi.advanceTimersByTimeAsync(20_000)
      await done
      const samsungTab = f.tabs.create.mock.results[1].value as Tab
      const urls = vi.mocked(samsungTab.view.webContents.loadURL).mock.calls.map(([url]) => url)
      expect(urls.filter((url) => url === canonical)).toHaveLength(scenario === 'allowed' ? 1 : 0)
      expect(urls.some((url) => url.includes('PRIVATE'))).toBe(false)
      expect(mocks.restore).toHaveBeenCalledTimes(scenario === 'allowed' ? 1 : 0)
      expect(f.runtime.status().results[1]).toMatchObject(
        scenario === 'allowed'
          ? { state: 'saved', loginAttempted: true }
          : { loginAttempted: false }
      )
      expect(JSON.stringify(f.statuses)).not.toContain('PRIVATE')
      f.runtime.dispose()
    }
  )
  it.each(['unknown_path', 'inspection_error', 'prior_block'])(
    'does not restore unknown auth for %s',
    async (scenario) => {
      if (scenario === 'prior_block')
        mocks.record = {
          version: 1,
          gapDays: 0,
          lastCovered: {},
          loginBlocked: { hyundai_card: true, samsung_card: true, lotte_card: true }
        }
      const f = setup()
      mocks.inspect.mockImplementation(async (tab: Tab) => {
        if (scenario === 'unknown_path') {
          const url = new URL(tab.view.webContents.getURL())
          await tab.view.webContents.loadURL(`${url.origin}/unverified-page`)
        }
        return {
          issuer: issuerForCardUrl(tab.view.webContents.getURL()),
          auth: 'unknown',
          state: scenario === 'inspection_error' ? 'error' : 'unknown'
        }
      })
      const done = f.runtime.tick()
      await vi.advanceTimersByTimeAsync(30_000)
      await done
      expect(mocks.restore).not.toHaveBeenCalled()
      expect(mocks.sync).not.toHaveBeenCalled()
      expect(
        f.runtime
          .status()
          .results.every(
            (row) =>
              row.reason ===
              (scenario === 'prior_block' ? 'attempt_protected' : 'login_unconfirmed')
          )
      ).toBe(true)
      f.runtime.dispose()
    }
  )
  it('obeys while-unlocked policy; device unlock is attempted only for existing always policy', async () => {
    const f = setup()
    f.vault.state.mockReturnValue('locked')
    await f.runtime.tick()
    expect(f.vault.ensureUnlockedByDevice).not.toHaveBeenCalled()
    expect(f.tabs.create).not.toHaveBeenCalled()
    f.settings.vaultAccessPolicy = 'always'
    await f.runtime.tick()
    expect(f.vault.ensureUnlockedByDevice).toHaveBeenCalledOnce()
    expect(f.tabs.create).not.toHaveBeenCalled()
    f.runtime.dispose()
  })
  it('halts credential entry on user tab change and keeps their chosen tab', async () => {
    const f = setup()
    mocks.inspect.mockResolvedValueOnce({ issuer: 'hyundai_card', auth: 'signed_out' })
    mocks.restore.mockImplementationOnce(async () => {
      f.tabs.focusTarget('user')
      await new Promise(() => {})
      return { auth: 'unknown' }
    })
    const done = f.runtime.tick()
    await vi.advanceTimersByTimeAsync(250)
    await done
    expect(f.runtime.status().results[0]).toMatchObject({ state: 'failed', reason: 'interrupted' })
    expect(f.tabs.active()?.id).toBe('user')
    expect(mocks.sync).toHaveBeenCalledTimes(2)
    f.runtime.dispose()
  })
  it('stops an in-flight collection when disabled; no following issuer starts', async () => {
    const f = setup()
    mocks.sync.mockImplementationOnce(async () => {
      await new Promise(() => {})
      return {}
    })
    const done = f.runtime.tick()
    await vi.advanceTimersByTimeAsync(1)
    f.settings.financeDailyEnabled = false
    await f.runtime.tick()
    await done
    expect(mocks.sync).toHaveBeenCalledOnce()
    expect(f.runtime.status().phase).toBe('paused')
    expect(f.release).toHaveBeenCalledOnce()
    f.runtime.dispose()
  })
  it('report failure cannot repeat or prevent collection', async () => {
    const f = setup()
    mocks.report.mockRejectedValue(new Error('PRIVATE-REMOTE-ERROR'))
    await f.runtime.tick()
    await f.runtime.tick()
    expect(mocks.sync).toHaveBeenCalledTimes(3)
    expect(f.runtime.status().phase).toBe('completed')
    expect(JSON.stringify(f.statuses)).not.toContain('PRIVATE')
    f.runtime.dispose()
  })
  it('checks only verified saved issuers and keeps the original receipt when later reconciliation fails', async () => {
    const f = setup()
    mocks.sync.mockResolvedValueOnce({
      ok: true,
      approvalComplete: false,
      complete: false,
      totalRows: 3,
      insertedRows: 0,
      updatedRows: 0,
      reviewRows: 3
    })
    mocks.reconcile.mockRejectedValue(new Error('PRIVATE-CHECK-ERROR'))
    await f.runtime.tick()
    expect(mocks.reconcile).toHaveBeenCalledTimes(2)
    expect(f.runtime.status().results[1]).toMatchObject({
      state: 'saved',
      insertedRows: 1,
      approvalComplete: true,
      reconciliation: { state: 'failed' }
    })
    expect(f.runtime.status().phase).toBe('needs_attention')
    expect(JSON.stringify(f.statuses)).not.toContain('PRIVATE')
    f.runtime.dispose()
  })
})
