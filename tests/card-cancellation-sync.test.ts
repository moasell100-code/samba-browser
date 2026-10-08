import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../src/main/browser/tab-manager'
import type { CardDateRange } from '../src/main/finance/card-api-types'
import { reconcileCardCancellations } from '../src/main/finance/card-cancellation-sync'
import {
  cancellationCardDateRange,
  cancellationCardRanges
} from '../src/main/finance/card-date-range'
const mocks = vi.hoisted(() => ({ exchange: vi.fn(), collect: vi.fn() }))
vi.mock('../src/main/finance/card-reconciliation-sync', () => ({
  exchangeReconciliation: mocks.exchange
}))
vi.mock('../src/main/finance/card-sync', () => ({ collectRecentCard: mocks.collect }))
const JOB = '00000000-0000-4000-8000-000000000001'
const range = { from: '2026-07-08', to: '2026-10-08' }
const ranges = cancellationCardRanges(range)
const identity = { mode: 'cancellation', range, ranges, query_basis: 'original_approval_date' }
const lease = (): Record<string, unknown> => ({
  ...identity,
  issuer: 'lotte_card',
  job_id: JOB,
  expires_at: '2026-10-08T03:20:00Z',
  state: 'leased'
})
const receipt = (): Record<string, unknown> => ({
  ...identity,
  source: 'lotte_card',
  job_id: JOB,
  updated_rows: 1,
  review_rows: 0,
  new_approvals: 0,
  coverage_verified: true,
  reconciliation_complete: true,
  complete: false
})
const tab = (): Tab =>
  ({
    profile: 'default',
    view: {
      webContents: Object.assign(new EventEmitter(), {
        getURL: () => 'https://www.lottecard.co.kr/app/LPMCDAA_V100.lc',
        isDestroyed: () => false
      })
    }
  }) as unknown as Tab
beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-08T03:00:00Z'))
  mocks.exchange.mockResolvedValueOnce(lease()).mockResolvedValueOnce(receipt())
  mocks.collect.mockImplementation(async ({ range }: { range: CardDateRange }) => ({
    rows: [],
    receipt: {
      issuer: 'lotte_card',
      range,
      pages: 1,
      rowCount: 0,
      complete: false,
      cancellationQueryComplete: true,
      cancellationQueryBasis: 'original_approval_date',
      issues: []
    }
  }))
})
afterEach(() => vi.useRealTimers())
describe('rolling cancellation synchronization', () => {
  it('queries exactly three calendar months in bounded chunks and sends one private completion', async () => {
    expect(await reconcileCardCancellations(tab(), { transport: 'server-ssh' })).toEqual({
      state: 'checked',
      checkedDays: 93,
      reviewRows: 0,
      updatedRows: 1
    })
    expect(mocks.collect.mock.calls.map(([args]) => args.range)).toEqual(ranges)
    expect(JSON.parse(mocks.exchange.mock.calls[0][1])).toEqual({
      issuer: 'lotte_card',
      mode: 'cancellation'
    })
    const saved = JSON.parse(mocks.exchange.mock.calls[1][1])
    expect(saved.job_id).toBe(JOB)
    expect(saved.data.days).toHaveLength(24)
  })
  it.each([
    { issuer: 'samsung_card' },
    { query_basis: 'issuer_display_date' },
    { range: { from: '2026-07-01', to: '2026-10-08' } },
    { ranges: ranges.slice(1) },
    { expires_at: '2026-10-08T02:59:00Z' }
  ])('rejects a foreign, old or incomplete lease %j', async (change) => {
    mocks.exchange.mockReset().mockResolvedValue({ ...lease(), ...change })
    expect((await reconcileCardCancellations(tab(), { transport: 'server-ssh' })).state).toBe(
      'failed'
    )
    expect(mocks.collect).not.toHaveBeenCalled()
  })
  it('preserves partial query evidence for review without claiming completion', async () => {
    mocks.collect.mockImplementation(async ({ range }: { range: CardDateRange }) => ({
      rows: [],
      receipt: {
        issuer: 'lotte_card',
        range,
        cancellationQueryComplete: false,
        cancellationQueryBasis: 'original_approval_date',
        issues: ['total_count_mismatch']
      }
    }))
    mocks.exchange
      .mockReset()
      .mockResolvedValueOnce(lease())
      .mockResolvedValueOnce({
        ...receipt(),
        coverage_verified: false,
        reconciliation_complete: false,
        review_rows: 1
      })
    expect(await reconcileCardCancellations(tab(), { transport: 'server-ssh' })).toMatchObject({
      state: 'needs_review',
      checkedDays: 0,
      reviewRows: 1
    })
    expect(mocks.exchange).toHaveBeenCalledTimes(2)
  })
  it('does not reuse a lease after navigation changes the signed-in tab', async () => {
    const current = tab()
    mocks.collect.mockImplementationOnce(async () => {
      current.view.webContents.emit(
        'did-start-navigation',
        {},
        'https://www.lottecard.co.kr/login',
        false,
        true
      )
      return {}
    })
    expect((await reconcileCardCancellations(current, { transport: 'server-ssh' })).state).toBe(
      'failed'
    )
    expect(mocks.exchange).toHaveBeenCalledTimes(1)
  })
  it('validates the acknowledgement issuer/job/range and forbids new approvals', async () => {
    mocks.exchange
      .mockReset()
      .mockResolvedValueOnce(lease())
      .mockResolvedValueOnce({ ...receipt(), source: 'samsung_card', new_approvals: 1 })
    expect((await reconcileCardCancellations(tab(), { transport: 'server-ssh' })).state).toBe(
      'failed'
    )
  })
  it('clamps month-end and the ledger start using Korea dates', () => {
    expect(() => cancellationCardDateRange(new Date('2026-05-30T15:00:00Z'))).toThrow()
    expect(cancellationCardDateRange(new Date('2026-08-30T15:00:00Z'))).toEqual({
      from: '2026-07-01',
      to: '2026-08-31'
    })
    expect(cancellationCardDateRange(new Date('2027-05-30T15:00:00Z'))).toEqual({
      from: '2027-02-28',
      to: '2027-05-31'
    })
    expect(() => cancellationCardRanges({ from: '2026-07-01', to: '2026-11-01' })).toThrow()
  })
})
