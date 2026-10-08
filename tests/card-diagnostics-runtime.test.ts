import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabManager } from '../src/main/browser/tab-manager'
import type { CardDiagnosticsBackend } from '../src/main/finance/card-diagnostics-mcp'

type MockObserver = {
  issuer: string
  state: 'idle' | 'watching' | 'stopped' | 'unavailable'
  dispose: ReturnType<typeof vi.fn>
}
const fixtureState = vi.hoisted(() => ({
  backend: undefined as CardDiagnosticsBackend | undefined,
  observers: [] as MockObserver[],
  startPause: undefined as Promise<void> | undefined,
  inspectPause: undefined as Promise<void> | undefined,
  inspect: vi.fn(),
  cancellationProbe: vi.fn(),
  cancelDateProbe: vi.fn(),
  lotteCancelDateProbe: vi.fn(),
  queryContract: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
  rmdir: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  mkdir: fixtureState.mkdir,
  writeFile: fixtureState.writeFile,
  unlink: fixtureState.unlink,
  rmdir: fixtureState.rmdir
}))
vi.mock('../src/main/finance/samsung-cancel-date-diagnostic', () => ({
  probeSamsungCancelDate: fixtureState.cancelDateProbe
}))
vi.mock('../src/main/finance/lotte-cancel-date-diagnostic', () => ({
  probeLotteCancellationDateBasis: fixtureState.lotteCancelDateProbe
}))
vi.mock('../src/main/finance/card-query-contract', () => ({
  inspectCardQueryContract: fixtureState.queryContract
}))
vi.mock('../src/main/browser/tab-manager', () => ({
  isTabAlive: (tab: Tab) => !!tab.view.webContents && !tab.view.webContents.isDestroyed()
}))
vi.mock('../src/main/finance/card-network-observer', () => ({
  CardNetworkObserver: class {
    state: MockObserver['state'] = 'idle'
    dispose = vi.fn(() => {
      this.state = 'stopped'
    })
    constructor(
      _wc: unknown,
      readonly issuer: string
    ) {
      fixtureState.observers.push(this)
    }
    async start(): Promise<void> {
      this.state = 'watching'
      await fixtureState.startPause
    }
    snapshot(): {
      state: MockObserver['state']
      issuer: string
      records: never[]
      limitReached: boolean
    } {
      return { state: this.state, issuer: this.issuer, records: [], limitReached: false }
    }
  }
}))
vi.mock('../src/main/finance/card-page-diagnostics', () => ({
  CARD_HISTORY_URLS: {
    lotte_card: 'https://www.lottecard.co.kr/app/LPMCDAA_V100.lc',
    samsung_card: 'https://www.samsungcard.com/personal/card/activity/UHPPRP0801M0.jsp'
  },
  issuerForCardUrl: (value: string) => {
    try {
      return (
        (
          {
            'https://www.lottecard.co.kr': 'lotte_card',
            'https://www.samsungcard.com': 'samsung_card'
          } as Record<string, string>
        )[new URL(value).origin] ?? null
      )
    } catch {
      return null
    }
  },
  inspectCardPage: async (tab: Tab) => {
    fixtureState.inspect(tab)
    await fixtureState.inspectPause
    return { state: 'ready' }
  }
}))
vi.mock('../src/main/finance/card-diagnostics-mcp', () => ({
  startCardDiagnosticsMcp: async (backend: CardDiagnosticsBackend, signal: AbortSignal) => {
    fixtureState.backend = backend
    signal.addEventListener('abort', () => backend.dispose(), { once: true })
    return {
      url: 'http://127.0.0.1:19000/mcp',
      bearerToken: 'synthetic-test-token',
      close: async () => {
        backend.dispose()
      }
    }
  }
}))
vi.mock('../src/main/finance/samsung-api-collector', () => ({
  collectSamsungApi: vi.fn(),
  collectSamsungCancellationApi: vi.fn(),
  probeSamsungCancellationDetails: fixtureState.cancellationProbe
}))

import { startCardDiagnosticsRuntime } from '../src/main/finance/card-diagnostics-runtime'

const LOTTE = 'https://www.lottecard.co.kr/app/LPMCDAA_V100.lc'
const SAMSUNG = 'https://www.samsungcard.com/personal/card/activity/UHPPRP0801M0.jsp'
const stops: Array<() => void> = []
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function fixture(options: { fresh?: boolean } = {}): Promise<{
  tab: Tab
  tabs: { get: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> }
  wc: EventEmitter & { loadURL: ReturnType<typeof vi.fn> }
  stop: () => void
  backend: CardDiagnosticsBackend
  setUrl: (url: string) => void
  setBusy: () => void
  destroy: () => void
}> {
  let url = options.fresh ? '' : LOTTE
  let created = !options.fresh
  let destroyed = false
  let busy = false
  const wc = Object.assign(new EventEmitter(), {
    getURL: () => url,
    isDestroyed: () => destroyed,
    loadURL: vi.fn(async (next: string) => {
      url = next
    })
  })
  const tab = {
    id: '00000000-0000-4000-8000-000000000001',
    view: { webContents: wc }
  } as unknown as Tab
  const tabs = {
    get: vi.fn((id: string) => (id === tab.id ? tab : undefined)),
    list: () => (created ? [{ id: tab.id, url, loading: false }] : []),
    create: vi.fn(() => {
      created = true
      return tab
    })
  }
  const stop = await startCardDiagnosticsRuntime({
    tabs: tabs as unknown as TabManager,
    tempDir: 'C:/synthetic-temp',
    sessionName: 'runtime-test-session',
    isBusy: () => busy
  })
  stops.push(stop)
  return {
    tab,
    tabs,
    wc,
    stop,
    backend: fixtureState.backend!,
    setUrl: (next: string) => {
      url = next
    },
    setBusy: () => {
      busy = true
    },
    destroy: () => {
      destroyed = true
      wc.emit('destroyed')
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  fixtureState.backend = undefined
  fixtureState.observers = []
  fixtureState.startPause = undefined
  fixtureState.inspectPause = undefined
  fixtureState.mkdir.mockResolvedValue(undefined)
  fixtureState.writeFile.mockResolvedValue(undefined)
  fixtureState.unlink.mockResolvedValue(undefined)
  fixtureState.rmdir.mockResolvedValue(undefined)
  fixtureState.cancellationProbe.mockResolvedValue({ detailRows: 1, validAmountRows: 1 })
  fixtureState.cancelDateProbe.mockResolvedValue({
    state: 'ready',
    dateBasis: 'unverified',
    scopes: []
  })
  fixtureState.queryContract.mockResolvedValue({ publicStatusOptions: [] })
  fixtureState.lotteCancelDateProbe.mockResolvedValue({
    issuer: 'lotte_card',
    filterVerified: true
  })
})
afterEach(async () => {
  for (const stop of stops.splice(0)) stop()
  await Promise.resolve()
  await Promise.resolve()
  vi.useRealTimers()
})

describe('card diagnostics runtime lifetime', () => {
  it('dispatches Samsung cancel-date counts without creating observers or changing tabs', async () => {
    const h = await fixture()
    expect(await h.backend.cancelDateProbe!(h.tab.id, '2026-08-01', '2026-08-04')).toEqual({
      state: 'filter_unverified'
    })
    expect(fixtureState.cancelDateProbe).not.toHaveBeenCalled()
    h.setUrl(SAMSUNG)
    expect(await h.backend.cancelDateProbe!(h.tab.id, '2026-08-01', '2026-08-04')).toMatchObject({
      state: 'ready',
      dateBasis: 'unverified'
    })
    expect(fixtureState.cancelDateProbe).toHaveBeenCalledExactlyOnceWith(
      h.tab,
      { from: '2026-08-01', to: '2026-08-04' },
      expect.any(AbortSignal)
    )
    expect(h.wc.loadURL).not.toHaveBeenCalled()
    expect(fixtureState.observers).toHaveLength(0)
    expect(fixtureState.writeFile).toHaveBeenCalledTimes(1)
  })
  it('dispatches Lotte only with unique verified public status enum attributes', async () => {
    const h = await fixture()
    for (const options of [
      [],
      [{ label: '전체', code: '0' }],
      [
        { label: '전체', code: '0' },
        { label: '취소', code: '0' }
      ],
      [
        { label: '전체', code: '0' },
        { label: '취소', code: '2' },
        { label: '정상', code: '2' }
      ],
      [
        { label: '전체', code: '0' },
        { label: '취소', code: '2' },
        { label: '취소', code: '3' }
      ]
    ]) {
      fixtureState.queryContract.mockResolvedValue({ publicStatusOptions: options })
      expect(await h.backend.cancelDateProbe!(h.tab.id, '2026-08-01', '2026-08-04')).toEqual({
        state: 'filter_unverified'
      })
    }
    expect(fixtureState.lotteCancelDateProbe).not.toHaveBeenCalled()
    fixtureState.queryContract.mockResolvedValue({
      publicStatusOptions: [
        { label: '전체', code: '0' },
        { label: '취소', code: '2' }
      ]
    })
    expect(await h.backend.cancelDateProbe!(h.tab.id, '2026-08-01', '2026-08-04')).toEqual({
      issuer: 'lotte_card',
      filterVerified: true
    })
    expect(fixtureState.lotteCancelDateProbe).toHaveBeenCalledExactlyOnceWith(
      h.tab,
      { from: '2026-08-01', to: '2026-08-04' },
      { signal: expect.any(AbortSignal), filterContract: { all: '0', cancellation: '2' } }
    )
    expect(h.wc.loadURL).not.toHaveBeenCalled()
    expect(fixtureState.observers).toHaveLength(0)
  })
  it('rejects invalid cancel-date ranges before invoking the helper', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-08T05:00:00Z'))
    const h = await fixture()
    h.setUrl(SAMSUNG)
    for (const [from, to] of [
      ['2026-06-30', '2026-07-01'],
      ['2026-08-01', '2026-08-05'],
      ['2026-09-31', '2026-09-31'],
      ['2026-10-08', '2026-10-09']
    ]) {
      expect(await h.backend.cancelDateProbe!(h.tab.id, from, to)).toEqual({
        state: 'invalid_range'
      })
    }
    expect(fixtureState.cancelDateProbe).not.toHaveBeenCalled()
  })
  it.each(['stop', 'navigate', 'busy'] as const)(
    'rejects pending cancel-date results after %s',
    async (change) => {
      const h = await fixture()
      h.setUrl(SAMSUNG)
      const wait = deferred()
      fixtureState.cancelDateProbe.mockImplementationOnce(
        async (_tab, _range, signal: AbortSignal) => {
          await wait.promise
          if (change === 'stop') expect(signal.aborted).toBe(true)
          return { state: 'ready', scopes: [] }
        }
      )
      const pending = h.backend.cancelDateProbe!(h.tab.id, '2026-08-01', '2026-08-04')
      const rejection = expect(pending).rejects.toThrow()
      if (change === 'stop') h.stop()
      else if (change === 'navigate') h.setUrl(LOTTE)
      else h.setBusy()
      wait.resolve()
      await rejection
    }
  )
  it('rejects future, pre-history, invalid and over-four-day cancellation probes before calling a service', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-07T05:00:00Z'))
    const h = await fixture()
    h.setUrl(SAMSUNG)
    for (const [from, to] of [
      ['2026-06-30', '2026-07-01'],
      ['2026-10-07', '2026-10-08']
    ])
      expect(await h.backend.cancellationContract!(h.tab.id, from, to)).toEqual({
        state: 'invalid_range'
      })
    await expect(
      h.backend.cancellationContract!(h.tab.id, '2026-09-31', '2026-09-31')
    ).rejects.toThrow()
    await expect(
      h.backend.cancellationContract!(h.tab.id, '2026-09-01', '2026-09-05')
    ).rejects.toThrow()
    expect(fixtureState.cancellationProbe).not.toHaveBeenCalled()
  })

  it('uses only the fixed cancellation probe and rejects a result after tab navigation', async () => {
    const h = await fixture()
    h.setUrl(SAMSUNG)
    const wait = deferred()
    fixtureState.cancellationProbe.mockImplementationOnce(async () => {
      await wait.promise
      return { detailRows: 1, validAmountRows: 1 }
    })
    const pending = h.backend.cancellationContract!(h.tab.id, '2026-08-17', '2026-08-17')
    expect(fixtureState.cancellationProbe).toHaveBeenCalledExactlyOnceWith(h.tab, {
      from: '2026-08-17',
      to: '2026-08-17'
    })
    h.setUrl(LOTTE)
    const rejected = expect(pending).rejects.toThrow('Card tab changed')
    wait.resolve()
    await rejected
  })
  it('reports safe load failure metadata without inspecting an error document or exposing the failed URL', async () => {
    const h = await fixture()
    h.wc.loadURL.mockRejectedValueOnce(
      new Error("net::ERR_PROXY_CONNECTION_FAILED loading 'https://PRIVATE-ACCOUNT?token=SECRET'")
    )
    const outcome = await h.backend.openHistory('lotte_card')
    expect(outcome).toEqual({
      tabId: h.tab.id,
      issuer: 'lotte_card',
      state: 'navigation_failed',
      auth: 'unknown',
      navigationFailure: { code: 'ERR_PROXY_CONNECTION_FAILED', category: 'proxy' }
    })
    expect(fixtureState.inspect).not.toHaveBeenCalled()
    expect(JSON.stringify(outcome)).not.toMatch(/PRIVATE|SECRET/)
  })
  it('finishes a new tab empty-to-about:blank transition before observing or opening history', async () => {
    const h = await fixture({ fresh: true })
    const wait = deferred()
    h.wc.loadURL.mockImplementationOnce(async (url: string) => {
      expect(url).toBe('about:blank')
      await wait.promise
      h.setUrl('about:blank')
    })
    const pending = h.backend.openHistory('lotte_card')
    expect(h.tabs.create).toHaveBeenCalledExactlyOnceWith({ url: 'about:blank' })
    expect(h.wc.loadURL).toHaveBeenCalledExactlyOnceWith('about:blank')
    expect(fixtureState.observers).toHaveLength(0)
    wait.resolve()
    await expect(pending).resolves.toMatchObject({ state: 'ready' })
    expect(h.wc.loadURL.mock.calls.map(([url]) => url)).toEqual(['about:blank', LOTTE])
    expect(fixtureState.observers).toHaveLength(1)
  })

  it.each(['stop', 'busy', 'navigate', 'destroy'] as const)(
    'does not attach or open history after %s during new blank preparation',
    async (change) => {
      const h = await fixture({ fresh: true })
      const wait = deferred()
      h.wc.loadURL.mockImplementationOnce(() => wait.promise)
      const pending = h.backend.openHistory('lotte_card')
      const rejected = expect(pending).rejects.toThrow()
      h.setUrl(change === 'navigate' ? SAMSUNG : 'about:blank')
      if (change === 'stop') h.stop()
      else if (change === 'busy') h.setBusy()
      else if (change === 'destroy') h.destroy()
      wait.resolve()
      await rejected
      expect(fixtureState.observers).toHaveLength(0)
      expect(h.wc.loadURL).toHaveBeenCalledExactlyOnceWith('about:blank')
    }
  )

  it('opens only the fixed history route, reuses an active observer, and cleans up its listener', async () => {
    const h = await fixture()
    await h.backend.openHistory('lotte_card')
    await h.backend.inspect(h.tab.id)
    expect(h.wc.loadURL).toHaveBeenCalledExactlyOnceWith(LOTTE)
    expect(fixtureState.observers).toHaveLength(1)
    expect(h.wc.listenerCount('destroyed')).toBe(1)
    expect(h.backend.list()).toMatchObject({ tabs: [{ observing: true }] })
    h.stop()
    expect(h.wc.listenerCount('destroyed')).toBe(0)
    expect(fixtureState.observers[0].dispose).toHaveBeenCalled()
    expect(() => h.backend.list()).toThrow('unavailable')
    expect(fixtureState.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/endpoint\.json$/),
      expect.any(String),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    )
  })

  it.each(['stopped', 'unavailable'] as const)(
    'replaces a %s observer without accumulating destroyed listeners',
    async (state) => {
      const h = await fixture()
      await h.backend.inspect(h.tab.id)
      fixtureState.observers[0].state = state
      expect(h.backend.list()).toMatchObject({ tabs: [{ observing: false }] })
      await h.backend.openHistory('lotte_card')
      expect(fixtureState.observers).toHaveLength(2)
      expect(fixtureState.observers[0].dispose).toHaveBeenCalled()
      expect(h.wc.listenerCount('destroyed')).toBe(1)
      expect(h.backend.list()).toMatchObject({ tabs: [{ observing: true }] })
    }
  )

  it('replaces the observer when the same tab changes issuer', async () => {
    const h = await fixture()
    await h.backend.inspect(h.tab.id)
    h.setUrl(SAMSUNG)
    expect(h.backend.list()).toMatchObject({ tabs: [{ issuer: 'samsung_card', observing: false }] })
    await h.backend.inspect(h.tab.id)
    expect(fixtureState.observers.map((observer) => observer.issuer)).toEqual([
      'lotte_card',
      'samsung_card'
    ])
    expect(fixtureState.observers[0].dispose).toHaveBeenCalled()
    expect(h.wc.listenerCount('destroyed')).toBe(1)
    expect(h.backend.requests(h.tab.id)).toMatchObject({ issuer: 'samsung_card' })
  })

  it('rejects stale request metadata after an issuer change', async () => {
    const h = await fixture()
    await h.backend.inspect(h.tab.id)
    h.setUrl(SAMSUNG)
    expect(() => h.backend.requests(h.tab.id)).toThrow('Card tab changed')
    expect(fixtureState.observers[0].dispose).toHaveBeenCalled()
    expect(h.wc.listenerCount('destroyed')).toBe(0)
  })

  it('uses the retained emitter if a destroyed view no longer exposes webContents', async () => {
    const h = await fixture()
    await h.backend.inspect(h.tab.id)
    const view = h.tab.view as unknown as { webContents: unknown }
    view.webContents = undefined
    expect(h.destroy).not.toThrow()
    expect(h.wc.listenerCount('destroyed')).toBe(0)
    expect(fixtureState.observers[0].dispose).toHaveBeenCalled()
  })

  it.each(['stop', 'busy', 'navigate', 'destroy'] as const)(
    'does not navigate after %s while observer start is pending',
    async (change) => {
      const h = await fixture()
      const wait = deferred()
      fixtureState.startPause = wait.promise
      const pending = h.backend.openHistory('lotte_card')
      const rejected = expect(pending).rejects.toThrow('unavailable')
      expect(h.wc.listenerCount('destroyed')).toBe(1)
      if (change === 'stop') h.stop()
      else if (change === 'busy') h.setBusy()
      else if (change === 'navigate') h.setUrl(SAMSUNG)
      else h.destroy()
      if (change === 'stop' || change === 'destroy')
        expect(fixtureState.observers[0].dispose).toHaveBeenCalled()
      wait.resolve()
      await rejected
      expect(h.wc.loadURL).not.toHaveBeenCalled()
      expect(fixtureState.observers[0].dispose).toHaveBeenCalled()
      expect(h.wc.listenerCount('destroyed')).toBe(0)
    }
  )

  it('does not return an inspection after the session is stopped', async () => {
    const h = await fixture()
    const wait = deferred()
    fixtureState.inspectPause = wait.promise
    const pending = h.backend.inspect(h.tab.id)
    const rejected = expect(pending).rejects.toThrow('unavailable')
    await vi.waitFor(() => expect(fixtureState.inspect).toHaveBeenCalled())
    h.stop()
    wait.resolve()
    await rejected
  })

  it('expires without leaving a pending observer or allowing navigation', async () => {
    vi.useFakeTimers()
    const h = await fixture()
    const wait = deferred()
    fixtureState.startPause = wait.promise
    const pending = h.backend.openHistory('lotte_card')
    const rejected = expect(pending).rejects.toThrow('unavailable')
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(fixtureState.observers[0].dispose).toHaveBeenCalled()
    expect(h.wc.listenerCount('destroyed')).toBe(0)
    wait.resolve()
    await rejected
    expect(h.wc.loadURL).not.toHaveBeenCalled()
    expect(fixtureState.unlink).toHaveBeenCalledWith(expect.stringMatching(/endpoint\.json$/))
  })

  it('blocks busy calls before creating a tab or observer', async () => {
    const h = await fixture()
    h.setBusy()
    await expect(h.backend.openHistory('lotte_card')).rejects.toThrow('unavailable')
    expect(h.tabs.create).not.toHaveBeenCalled()
    expect(fixtureState.observers).toHaveLength(0)
  })
})
