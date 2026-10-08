import { z } from 'zod'
import type { Tab } from '../browser/tab-manager'
import type { CardApiCollector, CardApiResult } from './card-api-types'
import type { CardSaveOptions } from './card-sync'
import { collectRecentCard } from './card-sync'
import { CARD_HISTORY_URLS, issuerForCardUrl } from './card-page-diagnostics'
import { cancellationCardDateRange, cancellationCardRanges, isCardDate } from './card-date-range'
import { collectHyundaiCancellationApi } from './hyundai-cancellation-collector'
import { collectSamsungCancellationApi } from './samsung-api-collector'
import { collectLotteCancellationApi } from './lotte-api-collector'
import { exchangeReconciliation, type CardReconciliationResult } from './card-reconciliation-sync'

const rangeSchema = z.object({
  from: z.string().refine(isCardDate),
  to: z.string().refine(isCardDate)
})
const identitySchema = z.object({
  issuer: z.enum(['hyundai_card', 'samsung_card', 'lotte_card']),
  mode: z.literal('cancellation'),
  range: rangeSchema,
  ranges: z.array(rangeSchema).min(1).max(24),
  query_basis: z.enum(['original_approval_date', 'issuer_display_date'])
})
const leaseSchema = identitySchema.extend({
  job_id: z.string().uuid().nullable(),
  expires_at: z.string().datetime({ offset: true }).nullable(),
  state: z.enum(['leased', 'no_work', 'daily_budget_used'])
})
const receiptSchema = identitySchema.omit({ issuer: true }).extend({
  job_id: z.string().uuid(),
  source: z.enum(['hyundai_card', 'samsung_card', 'lotte_card']),
  updated_rows: z.number().int().min(0).max(10000),
  review_rows: z.number().int().min(0).max(10000),
  new_approvals: z.literal(0),
  coverage_verified: z.boolean(),
  reconciliation_complete: z.boolean(),
  complete: z.literal(false)
})
export const cancellationCollectors: Record<
  'hyundai_card' | 'samsung_card' | 'lotte_card',
  CardApiCollector
> = {
  hyundai_card: collectHyundaiCancellationApi,
  samsung_card: collectSamsungCancellationApi,
  lotte_card: collectLotteCancellationApi
}

/** Daily rolling-three-month queries; old full-history reconciliation is not scheduled. */
export async function reconcileCardCancellations(
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
  const url = wc.getURL()
  const profile = tab.profile
  const stop = (): void => controller.abort()
  const navigate = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean): void => {
    if (mainFrame) stop()
  }
  const timer = setTimeout(stop, 8 * 60_000)
  wc.on('did-start-navigation', navigate)
  wc.on('destroyed', stop)
  const unchanged = (): boolean =>
    !signal.aborted &&
    !wc.isDestroyed() &&
    tab.view.webContents === wc &&
    tab.profile === profile &&
    wc.getURL() === url
  try {
    if (!unchanged()) return failed
    const issuer = issuerForCardUrl(url)
    if (!issuer || new URL(url).pathname !== new URL(CARD_HISTORY_URLS[issuer]).pathname)
      return failed
    const requestOptions = { ...options, signal }
    const expected = cancellationCardDateRange()
    const ranges = cancellationCardRanges(expected)
    const basis = issuer === 'hyundai_card' ? 'issuer_display_date' : 'original_approval_date'
    const lease = leaseSchema.parse(
      await exchangeReconciliation(
        'reconcile-lease',
        JSON.stringify({ issuer, mode: 'cancellation' }),
        'lease',
        requestOptions
      )
    )
    if (
      !unchanged() ||
      lease.issuer !== issuer ||
      lease.query_basis !== basis ||
      JSON.stringify(lease.range) !== JSON.stringify(expected) ||
      JSON.stringify(lease.ranges) !== JSON.stringify(ranges)
    )
      return failed
    if (lease.state !== 'leased') {
      if (lease.job_id !== null || lease.expires_at !== null) return failed
      return { ...failed, state: 'no_work' }
    }
    if (!lease.job_id || !lease.expires_at || Date.parse(lease.expires_at) <= Date.now())
      return failed
    const days: CardApiResult[] = []
    for (const range of ranges) {
      if (!unchanged()) return failed
      const part = await collectRecentCard({
        tab,
        collect: cancellationCollectors[issuer],
        range,
        signal
      })
      if (
        !unchanged() ||
        part.receipt.issuer !== issuer ||
        JSON.stringify(part.receipt.range) !== JSON.stringify(range) ||
        part.receipt.cancellationQueryBasis !== basis
      )
        return failed
      days.push(part)
      if (part.receipt.issues.some((code) => /auth|session|navigation|abort/.test(code))) break
    }
    if (!unchanged() || days.length !== ranges.length) return failed
    const receipt = receiptSchema.parse(
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
      !unchanged() ||
      receipt.job_id !== lease.job_id ||
      receipt.source !== issuer ||
      receipt.query_basis !== basis ||
      JSON.stringify(receipt.range) !== JSON.stringify(expected) ||
      JSON.stringify(receipt.ranges) !== JSON.stringify(ranges)
    )
      return failed
    const verified =
      receipt.coverage_verified &&
      receipt.reconciliation_complete &&
      days.every((part) => part.receipt.cancellationQueryComplete === true)
    return {
      state: verified && !receipt.review_rows ? 'checked' : 'needs_review',
      checkedDays: verified
        ? (Date.parse(expected.to) - Date.parse(expected.from)) / 86400000 + 1
        : 0,
      reviewRows: receipt.review_rows,
      updatedRows: receipt.updated_rows
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
