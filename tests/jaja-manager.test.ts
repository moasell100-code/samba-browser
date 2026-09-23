import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, WebContents, WebFrameMain } from 'electron'
import type { TabManager } from '../src/main/browser/tab-manager'
import type { JajaAccount, JajaCookieResult, JajaSession, JajaStatus } from '../src/shared/jaja'
import type { JajaStore } from '../src/main/jaja/store'
import { JajaApiError, type JajaClient } from '../src/main/jaja/client'
import { JajaManager, paymentInProgress } from '../src/main/jaja/manager'
import { probeSession } from '../src/main/jaja/probe'

const requestObservers = vi.hoisted(
  () =>
    new Map<unknown, (details: { url: string; requestHeaders: Record<string, string> }) => void>()
)

vi.mock('electron', () => ({ session: { fromPartition: vi.fn() } }))
vi.mock('../src/main/jaja/probe', () => ({ probeSession: vi.fn() }))
vi.mock('../src/main/browser/request-hooks', () => ({
  observeSessionRequests: vi.fn(
    (
      browser: unknown,
      _key: string,
      callback: (details: { url: string; requestHeaders: Record<string, string> }) => void
    ) => {
      requestObservers.set(browser, callback)
      return () => requestObservers.delete(browser)
    }
  )
}))

const HOST = 'jaja-browser-synthetic-host'
const SESSION_A = '11111111-1111-4111-8111-111111111111'
const SESSION_B = '22222222-2222-4222-8222-222222222222'
const SYNTHETIC_KEY = 'a'.repeat(64)
const instances: JajaManager[] = []

const account = (id: string): JajaAccount => ({
  accountId: `sa_${id}`,
  site: 'MUSINSA',
  label: `Synthetic ${id}`,
  usernameHint: `${id}***`,
  syncSupported: true
})
const remote = (id: string, sessionId: string): JajaSession => ({
  sessionId,
  accountId: `sa_${id}`,
  site: 'MUSINSA',
  hostId: HOST,
  state: 'observe',
  revision: 1,
  identityState: 'unchecked',
  providerSessionId: null,
  syncSupported: true
})
const syntheticCookie = (
  owner: string
): {
  name: string
  value: string
  domain: string
  path: string
  httpOnly: boolean
  secure: boolean
} => ({
  name: 'mss_mac',
  value: `test.${Buffer.from(JSON.stringify({ sub: owner })).toString('base64url')}.test`,
  domain: '.musinsa.com',
  path: '/',
  httpOnly: true,
  secure: true
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// Preserve inferred Vitest mock signatures so individual tests can override them precisely.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function browserFixture(owner: string) {
  const cookies = Object.assign(new EventEmitter(), {
    get: vi.fn(async () => [syntheticCookie(owner)]),
    flushStore: vi.fn(async () => {})
  })
  return { cookies, fetch: vi.fn(async () => new Response('')) }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture(connected = true) {
  let key: string | null = connected ? SYNTHETIC_KEY : null
  const accounts = [account('a'), account('b')]
  const remotes = [remote('a', SESSION_A), remote('b', SESSION_B)]
  const store = {
    origin: 'https://api.ja-ja.org',
    hostId: HOST,
    key: vi.fn(() => key),
    connect: vi.fn((_origin: string, incoming: string) => {
      key = incoming
    }),
    disconnect: vi.fn(() => {
      key = null
    }),
    sessionId: vi.fn((id: string) => (id === 'sa_a' ? SESSION_A : SESSION_B)),
    rememberSession: vi.fn()
  }
  const browsers = new Map([
    [`persist:jaja-${SESSION_A}`, browserFixture('synthetic-a')],
    [`persist:jaja-${SESSION_B}`, browserFixture('synthetic-b')]
  ])
  type FakeTab = { id: string; view: { webContents: WebContents }; url?: string }
  const visibleTabs: Array<{ id: string; url: string; kind?: 'popup' }> = []
  const tabMap = new Map<string, FakeTab>()
  const tabs = {
    get: vi.fn((id: string) => tabMap.get(id) ?? null),
    list: vi.fn(() => visibleTabs.filter((tab) => tab.kind !== 'popup')),
    listAll: vi.fn(() => visibleTabs),
    focusTarget: vi.fn(),
    createInSession: vi.fn((options: { url: string; partition: string; profile: string }) => {
      const id = `tab-${tabMap.size + 1}`
      const frame = { url: options.url } as WebFrameMain
      const wc = {
        session: browsers.get(options.partition),
        isDestroyed: () => false,
        mainFrame: frame,
        getURL: () => frame.url
      } as unknown as WebContents
      tabMap.set(id, { id, view: { webContents: wc } })
      visibleTabs.push({ id, url: options.url })
      return { id, url: options.url, profile: options.profile }
    })
  }
  const client = {
    accounts: vi.fn(async () => ({ hostId: HOST, accounts })),
    sessions: vi.fn(async () => ({ sessions: remotes.map((value) => ({ ...value })) })),
    register: vi.fn(async (id: string, sessionId: string) => ({
      ...remote(id.slice(3), sessionId)
    })),
    session: vi.fn(async (id: string) => ({ ...remotes.find((value) => value.sessionId === id)! })),
    cookies: vi.fn(
      async (
        value: JajaSession,
        _cookie: string,
        _extra: Record<string, unknown>
      ): Promise<JajaCookieResult> => ({
        sessionId: value.sessionId,
        mode: value.state === 'active' ? 'sync' : 'observe',
        revision: value.revision + 1,
        identityState: 'verified',
        accepted: true,
        synced: value.state === 'active',
        reason: 'verified'
      })
    ),
    activate: vi.fn(async (value: JajaSession): Promise<JajaSession> => ({
      ...value,
      state: 'active',
      revision: value.revision + 1
    })),
    pause: vi.fn(async (value: JajaSession): Promise<JajaSession> => ({
      ...value,
      state: 'paused',
      revision: value.revision + 1
    })),
    release: vi.fn(async (value: JajaSession): Promise<JajaSession> => ({
      ...value,
      state: 'released',
      revision: value.revision + 1
    })),
    signals: vi.fn(async () => ({ signals: [] }))
  }
  const statuses: JajaStatus[] = []
  const makeSession = vi.fn((partition: string) => browsers.get(partition)! as unknown as Session)
  const makeClient = vi.fn(() => client as unknown as JajaClient)
  const manager = new JajaManager(
    store as unknown as JajaStore,
    tabs as unknown as TabManager,
    (status) => statuses.push(status),
    makeSession,
    makeClient
  )
  instances.push(manager)
  return {
    manager,
    store,
    tabs,
    client,
    statuses,
    accounts,
    remotes,
    makeSession,
    makeClient,
    browsers,
    browserA: browsers.get(`persist:jaja-${SESSION_A}`)!,
    browserB: browsers.get(`persist:jaja-${SESSION_B}`)!,
    tabMap,
    visibleTabs
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-23T00:00:00Z'))
  vi.clearAllMocks()
  requestObservers.clear()
  vi.mocked(probeSession).mockResolvedValue({
    state: 'candidate',
    reason: 'protected_page_responded'
  })
})
afterEach(() => {
  for (const manager of instances.splice(0)) manager.dispose()
  vi.useRealTimers()
})

describe('JAJA account context manager', () => {
  it('creates independent persistent account sessions and reuses them on refresh', async () => {
    const f = fixture()
    await f.manager.start()
    expect(f.makeSession.mock.calls.map(([partition]) => partition)).toEqual([
      `persist:jaja-${SESSION_A}`,
      `persist:jaja-${SESSION_B}`
    ])
    await f.manager.refresh()
    expect(f.makeSession).toHaveBeenCalledTimes(2)
    f.manager.open('sa_a')
    f.manager.open('sa_b')
    expect(f.tabs.createInSession.mock.calls.map(([options]) => options.partition)).toEqual([
      `persist:jaja-${SESSION_A}`,
      `persist:jaja-${SESSION_B}`
    ])
    f.manager.open('sa_a')
    expect(f.tabs.createInSession).toHaveBeenCalledTimes(2)
    expect(f.tabs.focusTarget).toHaveBeenCalledWith('tab-1')
  })

  it('keeps comparison sessions in observe state without activating a provider', async () => {
    const f = fixture()
    await f.manager.start()
    await f.manager.check('sa_a')
    expect(f.client.cookies).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'sa_a', state: 'observe' }),
      expect.stringContaining('mss_mac='),
      expect.objectContaining({ browserState: 'candidate' })
    )
    expect(f.client.activate).not.toHaveBeenCalled()
    expect(f.manager.status().accounts[0].message).toBe('observed')
  })

  it('reads and uploads only the target partition cookies', async () => {
    const f = fixture()
    await f.manager.start()
    await f.manager.check('sa_a')
    expect(f.browserA.cookies.get).toHaveBeenCalledTimes(1)
    expect(f.browserB.cookies.get).not.toHaveBeenCalled()
    expect(f.client.cookies.mock.calls[0][1]).toBe(
      `mss_mac=${syntheticCookie('synthetic-a').value}`
    )
    await f.manager.check('sa_b')
    expect(f.client.cookies.mock.calls[1][1]).toBe(
      `mss_mac=${syntheticCookie('synthetic-b').value}`
    )
  })

  it('passes the correct native session fetch to the probe', async () => {
    const f = fixture()
    vi.mocked(probeSession).mockImplementation(async (_policy, fetcher) => {
      await fetcher('https://www.musinsa.com/mypage/myreview', { redirect: 'manual' })
      return { state: 'candidate', reason: 'protected_page_responded' }
    })
    await f.manager.start()
    await f.manager.check('sa_b')
    expect(f.browserB.fetch).toHaveBeenCalledTimes(1)
    expect(f.browserA.fetch).not.toHaveBeenCalled()
  })

  it('does not expose added server secret fields, cookies or the connection key in UI status', async () => {
    const f = fixture()
    Object.assign(f.accounts[0], { password: 'unwanted-password', cookie: 'unwanted-cookie' })
    Object.assign(f.remotes[0], {
      apiKey: 'unwanted-key',
      credential: { password: 'nested-secret' }
    })
    await f.manager.start()
    await f.manager.check('sa_a')
    const output = JSON.stringify([f.manager.status(), ...f.statuses])
    for (const forbidden of [
      'unwanted-password',
      'unwanted-cookie',
      'unwanted-key',
      'nested-secret',
      SYNTHETIC_KEY,
      syntheticCookie('synthetic-a').value
    ]) {
      expect(output).not.toContain(forbidden)
    }
    expect(f.manager.status().accounts[0].autoLoginSupported).toBe(false)
  })

  it('does not upload an expired browser session even with a previously captured cookie', async () => {
    const f = fixture()
    await f.manager.start()
    requestObservers.get(f.browserA)!({
      url: 'https://www.musinsa.com/',
      requestHeaders: { Cookie: 'mss_mac=old-synthetic-token' }
    })
    vi.mocked(probeSession).mockResolvedValueOnce({ state: 'expired', reason: 'login_redirect' })
    await f.manager.check('sa_a')
    expect(f.client.cookies).not.toHaveBeenCalled()
    expect(f.manager.status().accounts[0].message).toBe('login_expired')
    f.browserA.cookies.get.mockResolvedValue([])
    await f.manager.check('sa_a')
    expect(f.client.cookies).not.toHaveBeenCalled()
  })

  it('discards saved capture after a logout cookie-change event', async () => {
    const f = fixture()
    await f.manager.start()
    requestObservers.get(f.browserA)!({
      url: 'https://www.musinsa.com/',
      requestHeaders: { Cookie: 'mss_mac=old-synthetic-token' }
    })
    f.browserA.cookies.get.mockResolvedValue([])
    f.browserA.cookies.emit('changed', {}, { name: 'mss_mac' }, 'explicit', true)
    await f.manager.check('sa_a')
    expect(f.client.cookies).not.toHaveBeenCalled()
  })

  it('does not upload a stale jar snapshot that finishes after logout', async () => {
    const f = fixture()
    await f.manager.start()
    const reading = deferred<void>()
    const jarResult = deferred<ReturnType<typeof syntheticCookie>[]>()
    f.browserA.cookies.get.mockImplementation(() => {
      reading.resolve()
      return jarResult.promise
    })
    const pending = f.manager.check('sa_a')
    await reading.promise
    f.browserA.cookies.emit('changed', {}, { name: 'mss_mac' }, 'explicit', true)
    jarResult.resolve([syntheticCookie('before-logout')])
    await pending
    expect(f.client.cookies).not.toHaveBeenCalled()
  })

  it('does not treat unknown network verification as a confirmed login expiry', async () => {
    const f = fixture()
    await f.manager.start()
    vi.mocked(probeSession).mockResolvedValue({ state: 'unknown', reason: 'probe_failed' })
    await f.manager.check('sa_a')
    expect(f.client.cookies).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ browserState: 'unknown' })
    )
    expect(f.manager.status().accounts[0].message).not.toBe('login_expired')
  })

  it('keeps a late upload result from verifying a browser that logged out during the upload', async () => {
    const f = fixture()
    await f.manager.start()
    const uploading = deferred<void>()
    const uploaded = deferred<JajaCookieResult>()
    f.client.cookies.mockImplementation(() => {
      uploading.resolve()
      return uploaded.promise
    })
    const pending = f.manager.check('sa_a')
    await uploading.promise
    f.browserA.cookies.emit('changed', {}, { name: 'mss_mac' }, 'explicit', true)
    uploaded.resolve({
      sessionId: SESSION_A,
      mode: 'observe',
      revision: 2,
      identityState: 'verified',
      accepted: true,
      synced: false
    })
    await pending
    expect(f.manager.status().accounts[0]).toMatchObject({
      browserIdentityState: 'unknown',
      message: 'cookies_changed',
      session: { identityState: 'verified' }
    })
    await expect(f.manager.action('sa_a', 'activate')).rejects.toThrow('다시 확인')
    expect(f.client.activate).not.toHaveBeenCalled()
  })

  it('allows explicit verification of paused sessions without activating them', async () => {
    const f = fixture()
    f.remotes[0].state = 'paused'
    await f.manager.start()
    await f.manager.check('sa_a')
    expect(f.client.cookies).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'paused' }),
      expect.any(String),
      expect.any(Object)
    )
    expect(f.client.activate).not.toHaveBeenCalled()
  })

  it('does not schedule periodic checks for paused and released sessions', async () => {
    const f = fixture()
    f.remotes[0].state = 'paused'
    f.remotes[1].state = 'released'
    await f.manager.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(probeSession).not.toHaveBeenCalled()
    expect(f.client.cookies).not.toHaveBeenCalled()
  })

  it('protects checkout pages before starting a probe', async () => {
    const f = fixture()
    await f.manager.start()
    f.manager.open('sa_a')
    f.visibleTabs[0].url = 'https://www.musinsa.com/order/order-form'
    await f.manager.check('sa_a')
    expect(probeSession).not.toHaveBeenCalled()
    expect(f.client.cookies).not.toHaveBeenCalled()
    expect(f.manager.status().accounts[0].message).toBe('payment_in_progress')
  })

  it('blocks an upload if payment begins while a probe is in flight', async () => {
    const f = fixture()
    await f.manager.start()
    f.manager.open('sa_a')
    const probeStarted = deferred<void>()
    const probeResult = deferred<Awaited<ReturnType<typeof probeSession>>>()
    vi.mocked(probeSession).mockImplementation(() => {
      probeStarted.resolve()
      return probeResult.promise
    })
    const pending = f.manager.check('sa_a')
    await probeStarted.promise
    f.visibleTabs[0].url = 'https://www.musinsa.com/order/order-form'
    probeResult.resolve({ state: 'candidate', reason: 'protected_page_responded' })
    await pending
    expect(f.client.cookies).not.toHaveBeenCalled()
  })

  it('blocks duplicate checks and state changes during an in-flight check', async () => {
    const f = fixture()
    await f.manager.start()
    const started = deferred<void>()
    const pendingProbe = deferred<Awaited<ReturnType<typeof probeSession>>>()
    vi.mocked(probeSession).mockImplementation(() => {
      started.resolve()
      return pendingProbe.promise
    })
    const first = f.manager.check('sa_a')
    await started.promise
    await f.manager.check('sa_a')
    await expect(f.manager.action('sa_a', 'pause')).rejects.toThrow()
    expect(f.client.session).toHaveBeenCalledTimes(1)
    expect(f.client.pause).not.toHaveBeenCalled()
    pendingProbe.resolve({ state: 'candidate', reason: 'protected_page_responded' })
    await first
  })

  it('serializes uploads from two different account partitions', async () => {
    const f = fixture()
    await f.manager.start()
    const firstStarted = deferred<void>()
    const releaseFirst = deferred<void>()
    let active = 0
    let maximum = 0
    f.client.cookies.mockImplementation(async (value) => {
      active++
      maximum = Math.max(maximum, active)
      if (value.accountId === 'sa_a') {
        firstStarted.resolve()
        await releaseFirst.promise
      }
      active--
      return {
        sessionId: value.sessionId,
        mode: 'observe',
        revision: 2,
        identityState: 'verified',
        accepted: true,
        synced: false
      }
    })
    const first = f.manager.check('sa_a')
    await firstStarted.promise
    const second = f.manager.check('sa_b')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.browserB.cookies.get).toHaveBeenCalledOnce()
    expect(f.client.cookies).toHaveBeenCalledOnce()
    releaseFirst.resolve()
    await Promise.all([first, second])
    expect(f.client.cookies).toHaveBeenCalledTimes(2)
    expect(maximum).toBe(1)
  })

  it('cancels a queued account upload when that account logs out while waiting', async () => {
    const f = fixture()
    await f.manager.start()
    const firstStarted = deferred<void>()
    const releaseFirst = deferred<JajaCookieResult>()
    f.client.cookies.mockImplementation(() => {
      firstStarted.resolve()
      return releaseFirst.promise
    })
    const first = f.manager.check('sa_a')
    await firstStarted.promise
    const second = f.manager.check('sa_b')
    const rejected = expect(second).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.browserB.cookies.get).toHaveBeenCalledOnce()
    f.browserB.cookies.emit('changed', {}, { name: 'mss_mac' }, 'explicit', true)
    releaseFirst.resolve({
      sessionId: SESSION_A,
      mode: 'observe',
      revision: 2,
      identityState: 'verified',
      accepted: true,
      synced: false
    })
    await first
    await rejected
    expect(f.client.cookies).toHaveBeenCalledOnce()
    expect(f.manager.status().accounts[1].browserIdentityState).toBe('unknown')
  })

  it('rechecks browser identity before activating after waiting behind another account upload', async () => {
    const f = fixture()
    await f.manager.start()
    await f.manager.check('sa_b')
    expect(f.manager.status().accounts[1].browserIdentityState).toBe('verified')
    const firstStarted = deferred<void>()
    const releaseFirst = deferred<JajaCookieResult>()
    f.client.cookies.mockImplementation(() => {
      firstStarted.resolve()
      return releaseFirst.promise
    })
    const first = f.manager.check('sa_a')
    await firstStarted.promise
    const activation = f.manager.action('sa_b', 'activate')
    const rejected = expect(activation).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(0)
    f.browserB.cookies.emit('changed', {}, { name: 'mss_mac' }, 'explicit', true)
    releaseFirst.resolve({
      sessionId: SESSION_A,
      mode: 'observe',
      revision: 2,
      identityState: 'verified',
      accepted: true,
      synced: false
    })
    await first
    await rejected
    expect(f.client.activate).not.toHaveBeenCalled()
  })

  it('does not silently retry a rejected revision with a fresh revision', async () => {
    const f = fixture()
    await f.manager.start()
    f.client.cookies.mockRejectedValue(new JajaApiError(409))
    await expect(f.manager.check('sa_a')).rejects.toThrow('서버 상태가 변경')
    expect(f.client.cookies).toHaveBeenCalledTimes(1)
    expect(f.manager.status().accounts[0].message).toBe('state_changed')
  })

  it('keeps the connection key when server ownership release fails', async () => {
    const f = fixture()
    f.remotes[0].state = 'active'
    await f.manager.start()
    f.client.release.mockRejectedValue(new JajaApiError(503))
    await expect(f.manager.disconnect()).rejects.toThrow()
    expect(f.store.disconnect).not.toHaveBeenCalled()
    expect(f.store.key()).toBe(SYNTHETIC_KEY)
    expect(f.manager.status().connected).toBe(true)
  })

  it('releases active and paused owners before deleting the local key', async () => {
    const f = fixture()
    f.remotes[0].state = 'active'
    f.remotes[1].state = 'paused'
    await f.manager.start()
    await f.manager.disconnect()
    expect(f.client.release).toHaveBeenCalledTimes(2)
    expect(f.client.release.mock.invocationCallOrder.at(-1)).toBeLessThan(
      f.store.disconnect.mock.invocationCallOrder[0]
    )
    expect(f.store.key()).toBeNull()
    expect(f.manager.status()).toMatchObject({ connected: false, accounts: [] })
    expect(requestObservers.size).toBe(0)
  })

  it('rejects an account-session mismatch before creating a partition', async () => {
    const f = fixture()
    f.remotes[0].site = 'SSG'
    await f.manager.start()
    expect(f.makeSession).not.toHaveBeenCalled()
    expect(f.manager.status().error).toBeTruthy()
  })

  it('requires manual login and never enables the inactive credential helper', async () => {
    const f = fixture()
    await f.manager.start()
    expect(() => f.manager.setAutoLogin('sa_a', true)).toThrow('자동 재로그인은 지원하지 않습니다')
    expect(f.manager.status().accounts.every((value) => !value.autoLogin)).toBe(true)
  })
})

describe('JAJA pairing sender checks', () => {
  it('accepts only the exact opened control tab main frame at the configured JAJA origin', async () => {
    const f = fixture(false)
    f.manager.connect()
    const wc = f.tabMap.get('tab-1')!.view.webContents
    expect(f.manager.pairStatus(wc, wc.mainFrame)).toEqual({ pending: true, hostId: HOST })
    const other = { ...wc } as WebContents
    expect(f.manager.pairStatus(other, wc.mainFrame)).toEqual({ pending: false })
    expect(f.manager.pairStatus(wc, { url: wc.mainFrame.url } as WebFrameMain)).toEqual({
      pending: false
    })
    await expect(f.manager.pairKey(other, wc.mainFrame, SYNTHETIC_KEY)).rejects.toThrow()
    expect(f.store.connect).not.toHaveBeenCalled()
    await f.manager.pairKey(wc, wc.mainFrame, SYNTHETIC_KEY)
    expect(f.store.connect).toHaveBeenCalledWith('https://api.ja-ja.org', SYNTHETIC_KEY)
    expect(f.manager.status().connected).toBe(true)
  })

  it('rejects pairing after the control frame navigates off origin or outside /samba', async () => {
    const f = fixture(false)
    f.manager.connect()
    const wc = f.tabMap.get('tab-1')!.view.webContents
    const frame = wc.mainFrame as unknown as { url: string }
    frame.url = 'https://outside.example/samba/extension-link'
    expect(f.manager.pairStatus(wc, wc.mainFrame).pending).toBe(false)
    frame.url = 'https://app.ja-ja.org/other'
    await expect(f.manager.pairKey(wc, wc.mainFrame, SYNTHETIC_KEY)).rejects.toThrow()
    expect(f.store.connect).not.toHaveBeenCalled()
  })

  it('expires pairing and rejects malformed keys without storing them', async () => {
    const f = fixture(false)
    f.manager.connect()
    const wc = f.tabMap.get('tab-1')!.view.webContents
    await expect(f.manager.pairKey(wc, wc.mainFrame, 'not-a-key')).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await expect(f.manager.pairKey(wc, wc.mainFrame, SYNTHETIC_KEY)).rejects.toThrow()
    expect(f.store.connect).not.toHaveBeenCalled()
  })

  it.each(['accounts-missing', 'sessions-denied', 'wrong-host'] as const)(
    'does not persist a key or leave a connected state when pairing preflight fails: %s',
    async (failure) => {
      const f = fixture(false)
      f.manager.connect()
      const wc = f.tabMap.get('tab-1')!.view.webContents
      if (failure === 'accounts-missing') f.client.accounts.mockRejectedValue(new JajaApiError(404))
      if (failure === 'sessions-denied') f.client.sessions.mockRejectedValue(new JajaApiError(401))
      if (failure === 'wrong-host') {
        f.client.accounts.mockResolvedValue({ hostId: 'different-host', accounts: f.accounts })
      }
      await expect(f.manager.pairKey(wc, wc.mainFrame, SYNTHETIC_KEY)).rejects.toThrow()
      expect(f.store.connect).not.toHaveBeenCalled()
      expect(f.store.key()).toBeNull()
      expect(f.client.register).not.toHaveBeenCalled()
      expect(f.manager.status()).toMatchObject({
        connected: false,
        connecting: false,
        accounts: [],
        error: expect.any(String)
      })
      expect(f.manager.pairStatus(wc, wc.mainFrame)).toEqual({ pending: false })
      expect(() => f.manager.connect()).not.toThrow()
    }
  )

  it('does not commit an old pairing key after the approved tab navigates away during preflight', async () => {
    const f = fixture(false)
    f.manager.connect()
    const wc = f.tabMap.get('tab-1')!.view.webContents
    const started = deferred<void>()
    const response = deferred<{ hostId: string; accounts: JajaAccount[] }>()
    f.client.accounts.mockImplementation(() => {
      started.resolve()
      return response.promise
    })
    const pairing = f.manager.pairKey(wc, wc.mainFrame, SYNTHETIC_KEY)
    const rejected = expect(pairing).rejects.toThrow()
    await started.promise
    const frame = wc.mainFrame as unknown as { url: string }
    frame.url = 'https://outside.example/'
    response.resolve({ hostId: HOST, accounts: f.accounts })
    await rejected
    expect(f.store.connect).not.toHaveBeenCalled()
    expect(f.manager.status().connected).toBe(false)
  })
})

describe('payment protection URL patterns', () => {
  it.each([
    'https://www.musinsa.com/order/order-form',
    'https://www.29cm.co.kr/order/checkout',
    'https://pay.ssg.com/payment.ssg',
    'https://www.lotteon.com/p/checkout'
  ])('recognizes %s', (url) => expect(paymentInProgress(url)).toBe(true))
  it('does not block an ordinary product page and protects an unknown popup', () => {
    expect(paymentInProgress('https://www.musinsa.com/products/123')).toBe(false)
    expect(paymentInProgress('about:blank', true)).toBe(true)
  })
})
