import {
  CARD_DAILY_ISSUERS,
  type CardDailyIssuer,
  type CardDailyReason,
  type CardDailyResult,
  type CardDailyStatus
} from '../../shared/card-daily'
import type { CardDailyFile, CardDailyStore } from './card-daily-store'
import { recentCardDateRange } from './card-date-range'

const DAY = 86_400_000
export function cardDailyOccurrence(now: number, hourKst: number): { date: string; next: string } {
  if (!Number.isInteger(hourKst) || hourKst < 0 || hourKst > 23)
    throw new Error('Invalid card schedule')
  const today = recentCardDateRange(new Date(now)).to
  const at = Date.parse(`${today}T${String(hourKst).padStart(2, '0')}:00:00+09:00`)
  const due = at <= now ? at : at - DAY
  return { date: recentCardDateRange(new Date(due)).to, next: new Date(due + DAY).toISOString() }
}
export interface CardDailySchedulerDeps {
  store: CardDailyStore
  settings(): { financeDailyEnabled: boolean; financeDailyHourKst: number }
  acquire(): (() => void) | null
  ready(signal: AbortSignal): Promise<CardDailyReason | null>
  run(
    issuer: CardDailyIssuer,
    signal: AbortSignal,
    allowLogin: boolean
  ): Promise<CardDailyResult & { verifiedSignedIn?: boolean }>
  onChanged?(status: CardDailyStatus): void
  onDispose?(): void
  now?(): number
}

/** No prompt/model path. Claims are durable before each issuer's one login/collection attempt. */
export class CardDailyScheduler {
  private record: CardDailyFile = { version: 1, gapDays: 0, lastCovered: {} }
  private storageFailed = false
  private running = false
  private disposed = false
  private reason: CardDailyReason | undefined
  private controller: AbortController | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private now: () => number
  constructor(private readonly deps: CardDailySchedulerDeps) {
    this.now = deps.now ?? Date.now
    try {
      this.record = deps.store.read()
      this.record.loginBlocked ??= {}
      for (const row of this.record.run?.results ?? []) {
        if (
          row.state === 'running' ||
          (row.state === 'needs_login' && this.record.loginBlocked[row.issuer] === undefined)
        )
          this.record.loginBlocked[row.issuer] = true
      }
      if (this.record.run?.results.some((row) => row.state === 'running')) {
        this.record.run.results = this.record.run.results.map((row) =>
          row.state === 'running'
            ? { issuer: row.issuer, state: 'failed', reason: 'interrupted' }
            : row
        )
        this.persist()
      }
    } catch {
      this.storageFailed = true
    }
  }
  start(): void {
    if (this.timer || this.disposed) return
    this.timer = setInterval(() => void this.tick(), 60_000)
    this.timer.unref?.()
    void this.tick()
  }
  dispose(): void {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.controller?.abort()
    this.deps.onDispose?.()
  }
  status(): CardDailyStatus {
    const settings = this.deps.settings()
    const run = this.record.run
    let nextRun = cardDailyOccurrence(this.now(), settings.financeDailyHourKst).next
    if (run && run.runDate >= recentCardDateRange(new Date(nextRun)).to)
      nextRun = new Date(Date.parse(nextRun) + DAY).toISOString()
    const attention = run?.results.some(
      (row) =>
        row.state === 'needs_login' ||
        row.state === 'failed' ||
        (row.state === 'saved' &&
          (!row.approvalComplete ||
            !!row.reviewRows ||
            row.reconciliation?.state === 'failed' ||
            row.reconciliation?.state === 'needs_review'))
    )
    return {
      enabled: settings.financeDailyEnabled,
      hourKst: settings.financeDailyHourKst,
      phase: !settings.financeDailyEnabled
        ? 'paused'
        : this.running
          ? 'running'
          : this.storageFailed || this.reason || attention || this.record.gapDays > 0
            ? 'needs_attention'
            : run?.finishedAt
              ? 'completed'
              : 'idle',
      ...(run
        ? { runDate: run.runDate, startedAt: run.startedAt, finishedAt: run.finishedAt }
        : {}),
      gapDays: this.record.gapDays,
      results: run?.results.map((row) => ({ ...row })) ?? [],
      nextRunAt: settings.financeDailyEnabled ? nextRun : null,
      ...(this.storageFailed
        ? { reason: 'storage_unavailable' as const }
        : this.reason
          ? { reason: this.reason }
          : this.record.gapDays > 0
            ? { reason: 'coverage_gap' as const }
            : {})
    }
  }
  private emit(): void {
    this.deps.onChanged?.(this.status())
  }
  private persist(): void {
    try {
      this.deps.store.write(this.record)
    } catch {
      this.storageFailed = true
      throw new Error('Card schedule storage unavailable')
    }
  }
  private ready(signal: AbortSignal): Promise<CardDailyReason | null> {
    return new Promise((resolve) => {
      let finished = false
      const finish = (reason: CardDailyReason | null): void => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        signal.removeEventListener('abort', stopped)
        resolve(reason)
      }
      const stopped = (): void => finish('interrupted')
      const timer = setTimeout(() => finish('timeout'), 30_000)
      if (signal.aborted) stopped()
      else {
        signal.addEventListener('abort', stopped, { once: true })
        void this.deps.ready(signal).then(finish, () => finish('sync_unavailable'))
      }
    })
  }
  async tick(): Promise<void> {
    if (this.disposed) return
    if (this.running) {
      if (!this.deps.settings().financeDailyEnabled) this.controller?.abort()
      return
    }
    const settings = this.deps.settings()
    if (!settings.financeDailyEnabled || this.storageFailed) {
      this.emit()
      return
    }
    const due = cardDailyOccurrence(this.now(), settings.financeDailyHourKst).date
    const prior = this.record.run
    const today = recentCardDateRange(new Date(this.now())).to
    // Enabling a brand-new schedule before its first due time does not invent yesterday's run.
    if (!prior && due < today) {
      this.emit()
      return
    }
    if (prior && prior.runDate >= due && prior.results.every((row) => row.state !== 'pending')) {
      this.emit()
      return
    }
    const release = this.deps.acquire()
    if (!release) {
      this.reason = 'agent_busy'
      this.emit()
      return
    }
    this.running = true
    this.controller = new AbortController()
    try {
      const ready = await this.ready(this.controller.signal)
      if (ready) {
        this.reason = ready
        return
      }
      if (this.disposed || !this.deps.settings().financeDailyEnabled) return
      this.reason = undefined
      if (!prior || prior.runDate < due) {
        for (const last of Object.values(this.record.lastCovered)) {
          if (last)
            this.record.gapDays = Math.max(
              this.record.gapDays,
              Math.max(0, (Date.parse(today) - Date.parse(last)) / DAY - 4)
            )
        }
        this.record.run = {
          runDate: today,
          startedAt: new Date(this.now()).toISOString(),
          results: CARD_DAILY_ISSUERS.map((issuer) => ({ issuer, state: 'pending' }))
        }
        this.persist()
      } else if (this.record.run!.runDate < today) {
        // A morning catchup already serves today's current-four-day window. Do not repeat at 09:00.
        this.record.run!.runDate = today
        this.persist()
      }
      this.emit()
      for (const issuer of CARD_DAILY_ISSUERS) {
        if (
          this.disposed ||
          this.controller.signal.aborted ||
          !this.deps.settings().financeDailyEnabled
        )
          break
        const run = this.record.run!
        const index = run.results.findIndex((row) => row.issuer === issuer)
        if (run.results[index].state !== 'pending') continue
        const allowLogin = !this.record.loginBlocked?.[issuer]
        // Claim the credential attempt before any asynchronous browser action. A crash cannot re-arm it.
        this.record.loginBlocked ??= {}
        this.record.loginBlocked[issuer] = true
        run.results[index] = { issuer, state: 'running' }
        this.persist()
        this.emit()
        let result: CardDailyResult
        let verifiedSignedIn = false
        try {
          const outcome = await this.deps.run(issuer, this.controller.signal, allowLogin)
          const { verifiedSignedIn: verified, ...receipt } = outcome
          verifiedSignedIn = verified === true && receipt.issuer === issuer
          result = receipt
        } catch {
          result = {
            issuer,
            state: 'failed',
            reason: this.controller.signal.aborted ? 'interrupted' : 'sync_unavailable'
          }
        }
        if (result.issuer !== issuer || ['pending', 'running'].includes(result.state))
          result = { issuer, state: 'failed', reason: 'sync_unavailable' }
        run.results[index] = result
        // Private, trusted session proof also survives a later save/network failure; never expose it.
        if (
          verifiedSignedIn ||
          result.state === 'saved' ||
          (allowLogin && result.loginAttempted === false)
        )
          this.record.loginBlocked[issuer] = false
        if (result.state === 'saved' && result.approvalComplete)
          this.record.lastCovered[issuer] = recentCardDateRange(new Date(run.startedAt)).to
        this.persist()
        this.emit()
      }
      if (this.record.run!.results.every((row) => row.state !== 'pending')) {
        this.record.run!.finishedAt = new Date(this.now()).toISOString()
        this.persist()
      }
    } catch {
      this.reason = this.storageFailed ? 'storage_unavailable' : 'sync_unavailable'
    } finally {
      this.running = false
      this.controller?.abort()
      this.controller = undefined
      release()
      this.emit()
    }
  }
}
