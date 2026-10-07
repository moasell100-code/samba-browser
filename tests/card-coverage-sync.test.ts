import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recoverCardCoverage } from '../src/main/finance/card-coverage-sync'
import type { Tab } from '../src/main/browser/tab-manager'
import type { CardApiCollector } from '../src/main/finance/card-api-types'
const mocks = vi.hoisted(() => ({ ssh: vi.fn(), collect: vi.fn(), save: vi.fn() }))
vi.mock('../src/main/finance/card-save-ssh', () => ({ saveCardCollectionOverSsh: mocks.ssh }))
vi.mock('../src/main/finance/card-sync', () => ({
  collectRecentCard: mocks.collect,
  saveCardCollection: mocks.save
}))
const tab = {
  view: {
    webContents: {
      getURL: (): string => 'https://www.lottecard.co.kr/app/LPMCDAA_V100.lc',
      isDestroyed: (): boolean => false
    }
  }
} as unknown as Tab
const collect = vi.fn() as unknown as CardApiCollector
const recent = { from: '2026-10-04', to: '2026-10-07' }
const old = { from: '2026-09-01', to: '2026-09-04' }
const window = (changes = {}): Record<string, unknown> => ({
  issuer: 'lotte_card',
  range: old,
  approvalRange: old,
  cancellationRange: recent,
  gapDays: 36,
  timeZone: 'Asia/Seoul',
  inclusiveDays: 4,
  ...changes
})
beforeEach(() => {
  vi.resetAllMocks()
  vi.useRealTimers()
  mocks.ssh.mockResolvedValue(window())
  mocks.collect.mockResolvedValue({
    rows: [{}],
    receipt: {
      issuer: 'lotte_card',
      range: old,
      approvalComplete: true,
      cancellationComplete: false
    }
  })
  mocks.save.mockResolvedValue({})
})
describe('independent recovery window', () => {
  it('queries only oldest bounded gap and retains unverified cancellation coverage', async () => {
    expect(await recoverCardCoverage(tab, collect, { transport: 'server-ssh' })).toBe(false)
    expect(mocks.ssh.mock.calls[0][2]).toBe('window')
    expect(mocks.collect.mock.calls[0][0].range).toEqual(old)
    expect(mocks.save).toHaveBeenCalledOnce()
  })
  it('recovers an approval outage gap even when an older cancellation cursor remains unproved', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-07T03:00:00Z'))
    const cancellation = { from: '2026-08-01', to: '2026-08-04' }
    mocks.ssh.mockResolvedValue(window({ range: cancellation, cancellationRange: cancellation }))
    expect(await recoverCardCoverage(tab, collect, { transport: 'server-ssh' })).toBe(false)
    expect(mocks.collect.mock.calls[0][0].range).toEqual(old)
    expect(mocks.save).toHaveBeenCalledOnce()
  })
  it('revisits the pending cancellation window after approval coverage catches up', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-07T03:00:00Z'))
    mocks.ssh.mockResolvedValue(window({ approvalRange: recent, cancellationRange: old }))
    expect(await recoverCardCoverage(tab, collect, { transport: 'server-ssh' })).toBe(false)
    expect(mocks.collect.mock.calls[0][0].range).toEqual(old)
  })
  it('does not recollect recent dates when there is no older gap', async () => {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date())
    const start = new Date(Date.parse(today) - 3 * 86400000).toISOString().slice(0, 10)
    mocks.ssh.mockResolvedValue(
      window({
        approvalRange: { from: start, to: today },
        cancellationRange: { from: start, to: today }
      })
    )
    expect(await recoverCardCoverage(tab, collect, { transport: 'server-ssh' })).toBe(true)
    expect(mocks.collect).not.toHaveBeenCalled()
  })
  it.each([
    { issuer: 'samsung_card' },
    { approvalRange: { from: '2026-06-30', to: '2026-07-02' } },
    { cancellationRange: { from: '2026-07-01', to: '2026-07-05' } }
  ])('rejects unbound or excessive ranges', async (change) => {
    mocks.ssh.mockResolvedValue(window(change))
    expect(await recoverCardCoverage(tab, collect, { transport: 'server-ssh' })).toBe(false)
    expect(mocks.collect).not.toHaveBeenCalled()
  })
  it('never saves failed empty collection or an aborted request', async () => {
    mocks.collect.mockResolvedValue({
      rows: [],
      receipt: {
        issuer: 'lotte_card',
        range: old,
        approvalComplete: false,
        cancellationComplete: false
      }
    })
    expect(await recoverCardCoverage(tab, collect, { transport: 'server-ssh' })).toBe(false)
    expect(mocks.save).not.toHaveBeenCalled()
    const aborted = new AbortController()
    aborted.abort()
    expect(
      await recoverCardCoverage(tab, collect, { transport: 'server-ssh', signal: aborted.signal })
    ).toBe(false)
  })
})
