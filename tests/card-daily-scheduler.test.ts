import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CardDailyScheduler, cardDailyOccurrence } from '../src/main/finance/card-daily-scheduler'
import { FileCardDailyStore, type CardDailyFile } from '../src/main/finance/card-daily-store'
import { CARD_DAILY_ISSUERS, type CardDailyResult } from '../src/shared/card-daily'

const at = '2026-10-05T00:00:00.000Z'
function fixture(initial: CardDailyFile = { version: 1, gapDays: 0, lastCovered: {} }): {
  scheduler: CardDailyScheduler
  getRecord(): CardDailyFile
  write: ReturnType<typeof vi.fn>
  settings: { financeDailyEnabled: boolean; financeDailyHourKst: number }
  ready: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
  acquire: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
} {
  let record = structuredClone(initial)
  const write = vi.fn((next: CardDailyFile) => {
    record = structuredClone(next)
  })
  const settings = { financeDailyEnabled: true, financeDailyHourKst: 9 }
  const ready = vi.fn().mockResolvedValue(null)
  const release = vi.fn()
  const acquire = vi.fn().mockReturnValue(release)
  const run = vi.fn(async (issuer): Promise<CardDailyResult> => ({
    issuer,
    state: 'saved',
    approvalComplete: true,
    complete: false,
    totalRows: 5,
    insertedRows: 2,
    updatedRows: 0,
    reviewRows: 0
  }))
  const scheduler = new CardDailyScheduler({
    store: { read: () => structuredClone(record), write },
    settings: () => settings,
    ready,
    acquire,
    run
  })
  return { scheduler, getRecord: () => record, write, settings, ready, run, acquire, release }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(at))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('KST fixed daily schedule', () => {
  it.each([false, true])(
    'preserves an existing login block=%s after an explicitly proven pre-login failure',
    async (previouslyBlocked) => {
      const f = fixture({
        version: 1,
        gapDays: 0,
        lastCovered: {},
        loginBlocked: { samsung_card: previouslyBlocked }
      })
      f.run.mockImplementation(async (issuer): Promise<CardDailyResult> => ({
        issuer,
        state: 'failed',
        reason: 'sync_unavailable',
        stage: 'prepare_tab',
        loginAttempted: false,
        failureKind: 'navigation_aborted'
      }))
      await f.scheduler.tick()
      expect(f.run.mock.calls[1][2]).toBe(!previouslyBlocked)
      expect(f.getRecord().loginBlocked?.samsung_card).toBe(previouslyBlocked)
    }
  )
  it('does not invent a prior run on initial enable before 09:00', async () => {
    vi.setSystemTime(new Date('2026-10-04T23:00:00Z'))
    const f = fixture()
    await f.scheduler.tick()
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.scheduler.status().nextRunAt).toBe(at)
    vi.setSystemTime(new Date(at))
    await f.scheduler.tick()
    expect(f.run).toHaveBeenCalledTimes(3)
  })
  it('performs a missed morning catchup once, without a second login at the same day scheduled hour', async () => {
    vi.setSystemTime(new Date('2026-10-04T23:00:00Z'))
    const f = fixture({
      version: 1,
      gapDays: 0,
      lastCovered: {},
      run: {
        runDate: '2026-10-03',
        startedAt: '2026-10-03T00:00:00.000Z',
        finishedAt: '2026-10-03T00:05:00.000Z',
        results: CARD_DAILY_ISSUERS.map((issuer) => ({
          issuer,
          state: 'saved',
          approvalComplete: true
        }))
      }
    })
    await f.scheduler.tick()
    expect(f.scheduler.status().runDate).toBe('2026-10-05')
    expect(f.scheduler.status().nextRunAt).toBe('2026-10-06T00:00:00.000Z')
    vi.setSystemTime(new Date(at))
    await f.scheduler.tick()
    expect(f.run).toHaveBeenCalledTimes(3)
  })
  it('calculates midnight/date boundaries independently of OS timezone', () => {
    expect(cardDailyOccurrence(Date.parse('2026-10-04T23:59:59Z'), 9)).toEqual({
      date: '2026-10-04',
      next: at
    })
    expect(cardDailyOccurrence(Date.parse(at), 9)).toEqual({
      date: '2026-10-05',
      next: '2026-10-06T00:00:00.000Z'
    })
    expect(cardDailyOccurrence(Date.parse('2026-12-31T15:00:00Z'), 0)).toEqual({
      date: '2027-01-01',
      next: '2027-01-01T15:00:00.000Z'
    })
    expect(() => cardDailyOccurrence(Date.now(), 24)).toThrow()
  })
  it('claims each issuer durably before invoking it and completes only once per due date', async () => {
    const f = fixture()
    f.run.mockImplementation(async (issuer): Promise<CardDailyResult> => {
      expect(f.getRecord().run?.results.find((row) => row.issuer === issuer)?.state).toBe('running')
      return { issuer, state: 'saved', approvalComplete: true }
    })
    await f.scheduler.tick()
    await f.scheduler.tick()
    expect(f.run.mock.calls.map(([issuer]) => issuer)).toEqual([...CARD_DAILY_ISSUERS])
    expect(f.scheduler.status().phase).toBe('completed')
    expect(f.release).toHaveBeenCalledTimes(1)
  })
  it('does nothing when disabled, busy or locked, then catches up without consuming a run', async () => {
    const f = fixture()
    f.settings.financeDailyEnabled = false
    await f.scheduler.tick()
    expect(f.acquire).not.toHaveBeenCalled()
    f.settings.financeDailyEnabled = true
    f.acquire.mockReturnValueOnce(null)
    await f.scheduler.tick()
    expect(f.scheduler.status().reason).toBe('agent_busy')
    f.ready.mockResolvedValueOnce('vault_locked')
    await f.scheduler.tick()
    expect(f.getRecord().run).toBeUndefined()
    expect(f.run).not.toHaveBeenCalled()
    await f.scheduler.tick()
    expect(f.run).toHaveBeenCalledTimes(3)
  })
  it('continues other issuers after a protected login but never repeats failed login on same day', async () => {
    const f = fixture()
    f.run.mockResolvedValueOnce({
      issuer: 'hyundai_card',
      state: 'needs_login',
      reason: 'attempt_protected'
    })
    await f.scheduler.tick()
    await f.scheduler.tick()
    expect(f.run).toHaveBeenCalledTimes(3)
    expect(f.scheduler.status().phase).toBe('needs_attention')
    expect(f.getRecord().lastCovered.hyundai_card).toBeUndefined()
    expect(f.getRecord().lastCovered.samsung_card).toBe('2026-10-05')
    expect(f.getRecord().loginBlocked?.hyundai_card).toBe(true)
    vi.setSystemTime(new Date('2026-10-06T00:00:00Z'))
    await f.scheduler.tick()
    expect(f.run.mock.calls[3][2]).toBe(false)
    expect(f.run.mock.calls[4][2]).toBe(true)
  })
  it('after restart never repeats an interrupted issuer; only unattempted issuers resume', async () => {
    const f = fixture({
      version: 1,
      gapDays: 0,
      lastCovered: {},
      run: {
        runDate: '2026-10-05',
        startedAt: at,
        results: [
          { issuer: 'hyundai_card', state: 'saved', approvalComplete: true },
          { issuer: 'samsung_card', state: 'running' },
          { issuer: 'lotte_card', state: 'pending' }
        ]
      }
    })
    await f.scheduler.tick()
    expect(f.run.mock.calls.map(([issuer]) => issuer)).toEqual(['lotte_card'])
    expect(f.scheduler.status().results[1]).toEqual({
      issuer: 'samsung_card',
      state: 'failed',
      reason: 'interrupted'
    })
  })
  it('marks gaps beyond the current four days and does one catchup rather than past-day loops', async () => {
    const f = fixture({
      version: 1,
      gapDays: 0,
      lastCovered: { hyundai_card: '2026-09-29' },
      run: {
        runDate: '2026-09-29',
        startedAt: '2026-09-29T00:00:00.000Z',
        finishedAt: '2026-09-29T00:05:00.000Z',
        results: CARD_DAILY_ISSUERS.map((issuer) => ({
          issuer,
          state: 'saved',
          approvalComplete: true
        }))
      }
    })
    await f.scheduler.tick()
    expect(f.run).toHaveBeenCalledTimes(3)
    expect(f.scheduler.status()).toMatchObject({
      runDate: '2026-10-05',
      gapDays: 2,
      phase: 'needs_attention',
      reason: 'coverage_gap'
    })
  })
  it('keeps the lease through a slow issuer and blocks overlapping ticks; dispose cancels it', async () => {
    const f = fixture()
    f.run.mockImplementationOnce(
      (issuer, signal: AbortSignal) =>
        new Promise<CardDailyResult>((resolve) => {
          signal.addEventListener('abort', () =>
            resolve({ issuer, state: 'failed', reason: 'interrupted' })
          )
        })
    )
    const active = f.scheduler.tick()
    await Promise.resolve()
    await f.scheduler.tick()
    expect(f.acquire).toHaveBeenCalledTimes(1)
    expect(f.release).not.toHaveBeenCalled()
    f.scheduler.dispose()
    await active
    expect(f.run).toHaveBeenCalledTimes(1)
    expect(f.release).toHaveBeenCalledOnce()
  })
  it('does not call login or collection when its durable claim cannot be written', async () => {
    const f = fixture()
    f.write.mockImplementation(() => {
      throw new Error('PRIVATE ERROR')
    })
    await f.scheduler.tick()
    await f.scheduler.tick()
    expect(f.run).not.toHaveBeenCalled()
    expect(f.scheduler.status().reason).toBe('storage_unavailable')
    expect(JSON.stringify(f.scheduler.status())).not.toContain('PRIVATE')
  })
  it('bounds configuration readiness without claiming or attempting any login', async () => {
    const f = fixture()
    f.ready.mockReturnValue(new Promise(() => {}))
    const work = f.scheduler.tick()
    await vi.advanceTimersByTimeAsync(30_000)
    await work
    expect(f.run).not.toHaveBeenCalled()
    expect(f.getRecord().run).toBeUndefined()
    expect(f.scheduler.status().reason).toBe('timeout')
    expect(f.release).toHaveBeenCalledOnce()
  })
})

describe('strict private-free local run store', () => {
  it('round trips receipts and rejects corruption/extra private values instead of re-arming', () => {
    const dir = mkdtempSync(join(tmpdir(), 'card-daily-test-'))
    const path = join(dir, 'runs.json')
    try {
      const store = new FileCardDailyStore(path)
      expect(store.read()).toEqual({ version: 1, gapDays: 0, lastCovered: {} })
      store.write({ version: 1, gapDays: 1, lastCovered: { lotte_card: '2026-10-05' } })
      expect(store.read().gapDays).toBe(1)
      expect(() => store.write({ ...store.read(), password: 'PRIVATE' } as CardDailyFile)).toThrow()
      expect(readFileSync(path, 'utf8')).not.toContain('PRIVATE')
      writeFileSync(path, '{bad')
      expect(() => store.read()).toThrow('storage unavailable')
      const scheduler = new CardDailyScheduler({
        store,
        settings: () => ({ financeDailyEnabled: true, financeDailyHourKst: 9 }),
        acquire: () => null,
        ready: async () => null,
        run: async (issuer) => ({ issuer, state: 'failed' })
      })
      expect(scheduler.status().reason).toBe('storage_unavailable')
    } finally {
      rmSync(dir, { recursive: true })
    }
  })
})
