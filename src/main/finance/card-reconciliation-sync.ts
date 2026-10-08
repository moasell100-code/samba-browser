import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import type { Tab } from '../browser/tab-manager'
import type { CardApiCollector, CardApiResult } from './card-api-types'
import type { CardSaveOptions } from './card-sync'
import { CARD_HISTORY_URLS, issuerForCardUrl } from './card-page-diagnostics'
import { isCardDate, recentCardDateRange } from './card-date-range'
import { collectRecentCard } from './card-sync'
import { collectHyundaiApi } from './hyundai-api-collector'
import { collectSamsungApi } from './samsung-api-collector'
import { collectLotteApi } from './lotte-api-collector'
import { saveCardCollectionOverSsh } from './card-save-ssh'

const issuerSchema = z.enum(['hyundai_card', 'samsung_card', 'lotte_card'])
const count = z.number().int().nonnegative().max(10000)
const leaseSchema = z.object({
  job_id: z.string().uuid().nullable(),
  issuer: issuerSchema,
  dates: z.array(z.string().refine(isCardDate)).max(31),
  expires_at: z.string().datetime({ offset: true }).nullable(),
  target_count: count,
  state: z.enum(['leased', 'no_work', 'daily_budget_used'])
})
const receiptSchema = z.object({
  job_id: z.string().uuid(),
  source: issuerSchema,
  dates: z.array(z.string().refine(isCardDate)).max(31),
  updated_rows: count,
  review_rows: count,
  new_approvals: z.literal(0),
  coverage_verified: z.boolean(),
  status_complete: z.boolean().optional(),
  reconciliation_complete: z.boolean().optional(),
  complete: z.literal(false)
})
const collectors: Record<z.infer<typeof issuerSchema>, CardApiCollector> = {
  hyundai_card: collectHyundaiApi,
  samsung_card: collectSamsungApi,
  lotte_card: collectLotteApi
}
export interface CardReconciliationResult {
  state: 'no_work' | 'checked' | 'needs_review' | 'failed'
  checkedDays: number
  reviewRows: number
  updatedRows: number
}

export async function exchangeReconciliation(
  command: 'reconcile-lease' | 'reconcile-complete',
  body: string,
  path: string,
  options: CardSaveOptions
): Promise<unknown> {
  if (Buffer.byteLength(body) > 8 * 1024 * 1024 || options.signal?.aborted) throw new Error()
  if (options.transport === 'server-ssh')
    return saveCardCollectionOverSsh(body, options.signal, command)
  if (options.transport !== 'local' || !options.tokenFile) throw new Error()
  const info = await stat(options.tokenFile)
  if (!info.isFile() || info.size > 1024) throw new Error()
  const token = (await readFile(options.tokenFile, 'utf8')).trim()
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error()
  const response = await fetch(
    `http://127.0.0.1:8000/api/imports/browser-card/reconciliation/${path}`,
    {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Finance-Collector-Token': token },
      body: command === 'reconcile-complete' ? JSON.stringify(JSON.parse(body).data) : body,
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000)
    }
  )
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error()
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 16000) throw new Error()
      chunks.push(part.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

/** Only backend-issued dates of existing ledger approvals; never enumerate arbitrary history. */
export async function reconcileKnownCards(
  tab: Tab,
  options: CardSaveOptions
): Promise<CardReconciliationResult> {
  const failed: CardReconciliationResult = {
    state: 'failed',
    checkedDays: 0,
    reviewRows: 0,
    updatedRows: 0
  }
  const controller = new AbortController()
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal
  const wc = tab.view.webContents
  const stop = (): void => controller.abort()
  const navigate = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean): void => {
    if (mainFrame) stop()
  }
  const timer = setTimeout(stop, 8 * 60_000)
  wc.on('did-start-navigation', navigate)
  wc.on('destroyed', stop)
  try {
    if (signal.aborted || wc.isDestroyed()) return failed
    const initialUrl = wc.getURL()
    const profile = tab.profile
    const issuer = issuerForCardUrl(initialUrl)
    if (!issuer || new URL(initialUrl).pathname !== new URL(CARD_HISTORY_URLS[issuer]).pathname)
      return failed
    const unchanged = (): boolean =>
      !signal.aborted &&
      tab.view.webContents === wc &&
      tab.profile === profile &&
      !wc.isDestroyed() &&
      wc.getURL() === initialUrl
    const requestOptions = { ...options, signal }
    const lease = leaseSchema.parse(
      await exchangeReconciliation(
        'reconcile-lease',
        JSON.stringify({ issuer, maxDays: 31 }),
        'lease',
        requestOptions
      )
    )
    if (!unchanged() || lease.issuer !== issuer) return failed
    if (lease.state !== 'leased') {
      if (lease.job_id !== null || lease.dates.length || lease.target_count) return failed
      return { ...failed, state: 'no_work' }
    }
    const today = Date.parse(recentCardDateRange().to)
    if (
      !lease.job_id ||
      !lease.expires_at ||
      !lease.dates.length ||
      !lease.target_count ||
      new Set(lease.dates).size !== lease.dates.length ||
      Date.parse(lease.expires_at) <= Date.now() ||
      lease.dates.some((day) => {
        const age = (today - Date.parse(day)) / 86400000
        return age < 4 || day < '2026-07-01'
      })
    )
      return failed
    const days: CardApiResult[] = []
    for (const day of lease.dates) {
      if (!unchanged()) return failed
      const result = await collectRecentCard({
        tab,
        collect: collectors[issuer],
        range: { from: day, to: day },
        signal
      })
      if (
        !unchanged() ||
        result.receipt.issuer !== issuer ||
        result.receipt.range.from !== day ||
        result.receipt.range.to !== day
      )
        return failed
      days.push(result)
      if (!result.receipt.approvalComplete) return failed
    }
    const reply = receiptSchema.parse(
      await exchangeReconciliation(
        'reconcile-complete',
        JSON.stringify({
          job_id: lease.job_id,
          data: { collectedAt: new Date().toISOString(), days }
        }),
        `${lease.job_id}/complete`,
        requestOptions
      )
    )
    if (
      reply.job_id !== lease.job_id ||
      reply.source !== issuer ||
      JSON.stringify(reply.dates) !== JSON.stringify(lease.dates)
    )
      return failed
    return {
      state:
        reply.coverage_verified &&
        reply.status_complete === true &&
        reply.reconciliation_complete === true &&
        !reply.review_rows
          ? 'checked'
          : 'needs_review',
      checkedDays: reply.coverage_verified && reply.status_complete === true ? days.length : 0,
      reviewRows: reply.review_rows,
      updatedRows: reply.updated_rows
    }
  } catch {
    return failed
  } finally {
    clearTimeout(timer)
    controller.abort()
    wc.removeListener('did-start-navigation', navigate)
    wc.removeListener('destroyed', stop)
  }
}
