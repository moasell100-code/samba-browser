import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../src/main/browser/tab-manager'
import type { CardApiResult, CardDateRange } from '../src/main/finance/card-api-types'
import { CARD_HISTORY_URLS } from '../src/main/finance/card-page-diagnostics'
import { reconcileKnownCards } from '../src/main/finance/card-reconciliation-sync'

const mocks = vi.hoisted(() => ({
  ssh: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
  hyundai: vi.fn(),
  samsung: vi.fn(),
  lotte: vi.fn()
}))
vi.mock('node:fs/promises', () => ({ stat: mocks.stat, readFile: mocks.readFile }))
vi.mock('../src/main/finance/card-save-ssh', () => ({ saveCardCollectionOverSsh: mocks.ssh }))
vi.mock('../src/main/finance/hyundai-api-collector', () => ({ collectHyundaiApi: mocks.hyundai }))
vi.mock('../src/main/finance/samsung-api-collector', () => ({ collectSamsungApi: mocks.samsung }))
vi.mock('../src/main/finance/lotte-api-collector', () => ({ collectLotteApi: mocks.lotte }))

const NOW = '2026-10-05T03:00:00.000Z'
const JOB = '00000000-0000-4000-8000-000000000001'
const TOKEN = 'a'.repeat(64)
const SSH = { transport: 'server-ssh' }
const FAILED = { state: 'failed', checkedDays: 0, reviewRows: 0, updatedRows: 0 }
const dayAgo = (age: number): string =>
  new Date(Date.parse('2026-10-05') - age * 86400000).toISOString().slice(0, 10)
const lease = (changes: Record<string, unknown> = {}): Record<string, unknown> => ({
  job_id: JOB,
  issuer: 'lotte_card',
  dates: [dayAgo(4)],
  expires_at: '2026-10-05T03:20:00Z',
  target_count: 1,
  state: 'leased',
  ...changes
})
const receipt = (changes: Record<string, unknown> = {}): Record<string, unknown> => ({
  job_id: JOB,
  source: 'lotte_card',
  dates: [dayAgo(4)],
  updated_rows: 1,
  review_rows: 0,
  new_approvals: 0,
  coverage_verified: true,
  complete: false,
  ...changes
})
function result(
  range: CardDateRange,
  changes: Partial<CardApiResult['receipt']> = {}
): CardApiResult {
  return {
    rows: [
      {
        issuer: 'lotte_card',
        sourceId: 'synthetic-source',
        kind: 'approval',
        approvedAt: `${range.from}T12:00:00+09:00`,
        approvalNumber: 'SYNTHETIC_APPROVAL',
        cardLast4: '1234',
        merchant: 'PRIVATE_MERCHANT',
        amount: 10000,
        currency: 'KRW',
        status: 'approved',
        cancellationAmount: 0,
        netAmount: 10000,
        needsReview: []
      }
    ],
    receipt: {
      issuer: 'lotte_card',
      range,
      pages: 1,
      rowCount: 1,
      approvalComplete: true,
      complete: false,
      elapsedMs: 1,
      issues: [],
      ...changes
    }
  }
}
function tabFixture(url = CARD_HISTORY_URLS.lotte_card): {
  tab: Tab
  wc: EventEmitter & { getURL: () => string; isDestroyed: () => boolean }
  navigate: (url: string) => void
} {
  let current = url
  const wc = Object.assign(new EventEmitter(), { getURL: () => current, isDestroyed: () => false })
  return {
    tab: { view: { webContents: wc } } as unknown as Tab,
    wc,
    navigate: (next) => {
      current = next
      wc.emit('did-start-navigation', {}, next, false, true)
    }
  }
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((done) => {
      resolve = done
    }),
    resolve: (value) => resolve(value)
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW))
  mocks.ssh.mockResolvedValueOnce(lease()).mockResolvedValueOnce(receipt())
  mocks.lotte.mockImplementation(async (_tab: Tab, range: CardDateRange) => result(range))
  mocks.stat.mockResolvedValue({ isFile: () => true, size: TOKEN.length })
  mocks.readFile.mockResolvedValue(TOKEN)
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected live request')))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('backend-scoped known approval reconciliation', () => {
  it('collects only backend-issued days and returns bounded metadata without raw rows', async () => {
    const { tab, wc } = tabFixture()
    const dates = [dayAgo(4), dayAgo(35), dayAgo(89)]
    mocks.ssh
      .mockReset()
      .mockResolvedValueOnce(lease({ dates }))
      .mockResolvedValueOnce(receipt({ dates, PRIVATE_ROWS: 'PRIVATE_REPLY' }))
    await expect(reconcileKnownCards(tab, SSH)).resolves.toEqual({
      state: 'checked',
      checkedDays: 3,
      reviewRows: 0,
      updatedRows: 1
    })
    expect(mocks.lotte.mock.calls.map((call) => call[1])).toEqual(
      dates.map((day) => ({ from: day, to: day }))
    )
    expect(mocks.samsung).not.toHaveBeenCalled()
    expect(mocks.hyundai).not.toHaveBeenCalled()
    expect(mocks.ssh.mock.calls.map((call) => call[2])).toEqual([
      'reconcile-lease',
      'reconcile-complete'
    ])
    expect(JSON.parse(mocks.ssh.mock.calls[0][0])).toEqual({ issuer: 'lotte_card' })
    const input = JSON.parse(mocks.ssh.mock.calls[1][0])
    expect(Object.keys(input).sort()).toEqual(['data', 'job_id'])
    expect(Object.keys(input.data).sort()).toEqual(['collectedAt', 'days'])
    expect(input.data.days).toHaveLength(3)
    expect(fetch).not.toHaveBeenCalled()
    expect(wc.listenerCount('did-start-navigation')).toBe(0)
    expect(wc.listenerCount('destroyed')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['recent day', { dates: [dayAgo(3)] }],
    ['today', { dates: [dayAgo(0)] }],
    ['older than window', { dates: [dayAgo(90)] }],
    ['future day', { dates: [dayAgo(-1)] }],
    ['duplicate day', { dates: [dayAgo(4), dayAgo(4)] }],
    ['four days', { dates: [4, 5, 6, 7].map(dayAgo) }],
    ['empty days', { dates: [] }],
    ['invalid calendar', { dates: ['2026-02-30'] }],
    ['other issuer', { issuer: 'samsung_card' }],
    ['expired', { expires_at: NOW }],
    ['no job', { job_id: null }],
    ['no targets', { target_count: 0 }],
    ['unbound job', { job_id: '../unbound-path' }],
    ['unknown state', { state: 'PRIVATE_STATE' }]
  ])('rejects %s before querying a card or submitting a completion', async (_label, change) => {
    mocks.ssh.mockReset().mockResolvedValue(lease(change))
    await expect(reconcileKnownCards(tabFixture().tab, SSH)).resolves.toEqual(FAILED)
    expect(mocks.lotte).not.toHaveBeenCalled()
    expect(mocks.ssh).toHaveBeenCalledTimes(1)
  })

  it.each(['no_work', 'daily_budget_used'])('stops on %s without querying', async (state) => {
    mocks.ssh
      .mockReset()
      .mockResolvedValue(
        lease({ state, dates: [], job_id: null, target_count: 0, expires_at: null })
      )
    await expect(reconcileKnownCards(tabFixture().tab, SSH)).resolves.toEqual({
      ...FAILED,
      state: 'no_work'
    })
    expect(mocks.lotte).not.toHaveBeenCalled()
  })

  it.each(['https://example.test/', 'https://www.lottecard.co.kr/invalid'])(
    'does not lease from unapproved page %s',
    async (url) => {
      await expect(reconcileKnownCards(tabFixture(url).tab, SSH)).resolves.toEqual(FAILED)
      expect(mocks.ssh).not.toHaveBeenCalled()
    }
  )

  it('does not submit incomplete approval pages', async () => {
    mocks.lotte.mockImplementation(async (_tab: Tab, range: CardDateRange) =>
      result(range, { approvalComplete: false, issues: ['page_limit'] })
    )
    await expect(reconcileKnownCards(tabFixture().tab, SSH)).resolves.toEqual(FAILED)
    expect(mocks.ssh).toHaveBeenCalledTimes(1)
  })

  it.each(['navigation', 'abort', 'destroyed'] as const)(
    'does not submit after %s during collection',
    async (reason) => {
      const f = tabFixture()
      const abort = new AbortController()
      mocks.lotte.mockImplementation(async (_tab: Tab, range: CardDateRange) => {
        if (reason === 'navigation') f.navigate('https://example.test/')
        if (reason === 'destroyed') f.wc.emit('destroyed')
        if (reason === 'abort') abort.abort()
        return result(range)
      })
      await expect(reconcileKnownCards(f.tab, { ...SSH, signal: abort.signal })).resolves.toEqual(
        FAILED
      )
      expect(mocks.ssh).toHaveBeenCalledTimes(1)
    }
  )

  it('rejects replacing webContents while a lease is pending', async () => {
    const f = tabFixture()
    const pendingLease = deferred<unknown>()
    mocks.ssh.mockReset().mockReturnValueOnce(pendingLease.promise).mockResolvedValueOnce(receipt())
    const pending = reconcileKnownCards(f.tab, SSH)
    f.tab.view.webContents = tabFixture().tab.view.webContents
    pendingLease.resolve(lease())
    await expect(pending).resolves.toEqual(FAILED)
    expect(mocks.lotte).not.toHaveBeenCalled()
    expect(mocks.ssh).toHaveBeenCalledTimes(1)
  })

  it.each([
    { source: 'samsung_card' },
    { job_id: '00000000-0000-4000-8000-000000000002' },
    { dates: [dayAgo(5)] },
    { new_approvals: 1 },
    { complete: true },
    { updated_rows: -1 }
  ])('rejects a conflicting completion receipt %j', async (change) => {
    mocks.ssh.mockReset().mockResolvedValueOnce(lease()).mockResolvedValueOnce(receipt(change))
    await expect(reconcileKnownCards(tabFixture().tab, SSH)).resolves.toEqual(FAILED)
  })

  it('marks unverified coverage as review without inventing checked days', async () => {
    mocks.ssh
      .mockReset()
      .mockResolvedValueOnce(lease())
      .mockResolvedValueOnce(receipt({ coverage_verified: false, review_rows: 1 }))
    await expect(reconcileKnownCards(tabFixture().tab, SSH)).resolves.toEqual({
      state: 'needs_review',
      checkedDays: 0,
      reviewRows: 1,
      updatedRows: 1
    })
  })

  it('local transport fixes the loopback URL and forbids redirects', async () => {
    const request = vi.mocked(fetch)
    request
      .mockResolvedValueOnce(
        new Response(JSON.stringify(lease({ next_url: 'https://example.test/PRIVATE' })))
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt())))
    await expect(
      reconcileKnownCards(tabFixture().tab, { transport: 'local', tokenFile: 'synthetic-token' })
    ).resolves.toMatchObject({ state: 'checked' })
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      'http://127.0.0.1:8000/api/imports/browser-card/reconciliation/lease',
      `http://127.0.0.1:8000/api/imports/browser-card/reconciliation/${JOB}/complete`
    ])
    for (const [, init] of request.mock.calls)
      expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(JSON.parse(request.mock.calls[1][1]!.body as string)).not.toHaveProperty('job_id')
    expect(mocks.ssh).not.toHaveBeenCalled()
  })

  it('local redirect or oversized reply never reaches a collector', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('PRIVATE_REDIRECT', { status: 302 }))
    const options = { transport: 'local', tokenFile: 'synthetic-token' }
    await expect(reconcileKnownCards(tabFixture().tab, options)).resolves.toEqual(FAILED)
    vi.mocked(fetch).mockResolvedValueOnce(new Response('x'.repeat(16001)))
    await expect(reconcileKnownCards(tabFixture().tab, options)).resolves.toEqual(FAILED)
    expect(mocks.lotte).not.toHaveBeenCalled()
  })
})
