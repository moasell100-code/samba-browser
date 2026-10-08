import { createHash } from 'node:crypto'
import type { CardApiCollector, CardApiRow, CardApiResult } from './card-api-types'
import { dailyCardRanges } from './card-date-range'
import { pageBridge } from '../browser/page-bridge'
import {
  date,
  dateTime,
  historyOrigin,
  initialRequestPlan,
  own,
  parseHyundaiApiPage,
  requestHyundaiApiPage,
  requestPlanScript,
  responseScopeIssue,
  scalar,
  won,
  type HyundaiApiForm,
  type HyundaiCardTail
} from './hyundai-api-collector'

const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

interface AcquiredPage {
  rows: CardApiRow[]
  items: unknown[]
  count: number | null
  total: number | null
  covered: boolean
  issues: string[]
}

/** Official purchase renderer: useDt, cancYn, calnMarkVl + (useAmt + excm).
 * The refund amount is not the original gross. Resolve that only in the ledger.
 */
export function parseHyundaiCancellationPage(
  response: unknown,
  queryDay: string,
  cardTails: readonly HyundaiCardTail[] = []
): AcquiredPage {
  const body = own(response, 'bdy') ?? response
  const items = own(body, 'acqrUseItmList')
  const issues = new Set<string>()
  if (!Array.isArray(items) || items.length > 1000)
    return {
      rows: [],
      items: [],
      count: null,
      total: null,
      covered: false,
      issues: ['acquired_response_schema_unverified']
    }
  const countText = scalar(own(own(body, 'rcntSummaryInfo'), 'totUseCnt'), 10)
  const total =
    countText && /^\d+$/.test(countText) && Number.isSafeInteger(Number(countText))
      ? Number(countText)
      : null
  if (total === null) issues.add('total_count_unverified')
  else if (total !== items.length) issues.add('total_count_mismatch')
  if (Math.max(items.length, total ?? 0) >= 630) issues.add('daily_row_limit_possible')
  let covered = total === items.length && !issues.size
  const rows: CardApiRow[] = []
  const ids = new Set<string>()
  const positiveSlips = new Set<string>()
  for (const item of items) {
    if (date(own(item, 'useDt')) !== queryDay) {
      covered = false
      issues.add('acquired_query_date_unverified')
    }
    const state = scalar(own(item, 'cancYn'), 4)
    if (state !== 'Y' && state !== 'N') {
      covered = false
      issues.add('acquired_status_unverified')
    }
    if (state === 'N') {
      const slip = scalar(own(item, 'slipNo'), 128)
      const reference = scalar(own(item, 'crno'), 128)
      if (slip && reference) positiveSlips.add(hash([reference, slip]))
    }
  }
  for (const raw of items) {
    const state = scalar(own(raw, 'cancYn'), 4)
    const use = won(own(raw, 'useAmt'))
    const exchange = won(own(raw, 'excm'))
    const magnitude = use !== null && exchange !== null ? use + exchange : null
    const sign = scalar(own(raw, 'calnMarkVl'), 8)
    // A cancelled original positive posting is not a refund event. The official
    // display prefix, not its status flag alone, identifies negative postings.
    if (state === 'N' && sign !== '-') continue
    if (state === 'Y' && (sign === '' || sign === '+') && magnitude !== null && magnitude >= 0) {
      issues.add('positive_cancelled_posting_observed')
      continue
    }
    const originalDate = date(own(raw, 'avDt')) ?? dateTime(own(raw, 'avDttm'))?.slice(0, 10)
    const queryDate = date(own(raw, 'useDt'))
    const approvalNumber = scalar(own(raw, 'avNo'), 80)
    const reference = scalar(own(raw, 'crno'), 128)
    const slip = scalar(own(raw, 'slipNo'), 128)
    // Reuse only the established card/merchant/approval identity adapter. Its
    // synthetic zero supplies no amount, status or cancellation evidence.
    const identity = parseHyundaiApiPage(
      {
        bdy: {
          rcntSummaryInfo: { totUseCnt: 1 },
          rcntAvItm: [
            {
              avUseItm: {
                ...(raw as object),
                // Official convertPurchaseItem sets useMrchNm = mrchNm for
                // acquired rows. An approval-only display alias is not evidence.
                useMrchNm: scalar(own(raw, 'mrchNm')),
                avAmt: 0,
                avClsf: '0',
                cancDttm: ''
              }
            }
          ]
        }
      },
      cardTails
    ).rows[0]
    if (!identity || !originalDate || !queryDate || !approvalNumber) {
      covered = false
      issues.add('acquired_refund_identity_unavailable')
      continue
    }
    const approvedAt = identity.approvedAt
    // Exact original-day/card/approval matching in the ledger is sufficient;
    // unavailable time must not fabricate an approval or weaken any conflict.
    const review = new Set(
      identity.needsReview.filter(
        (code) => !['approval_datetime_unverified', 'approval_time_unavailable'].includes(code)
      )
    )
    if (state !== 'Y') review.add('cancellation_status_unverified')
    if (queryDate < approvedAt.slice(0, 10)) review.add('cancellation_date_unverified')
    const validAmount =
      sign === '-' &&
      magnitude !== null &&
      Number.isSafeInteger(magnitude) &&
      magnitude > 0 &&
      magnitude <= 999_999_999_999
    if (!validAmount) review.add('cancellation_amount_unverified')
    const id =
      reference && slip ? hash(['hyundai_card', 'acquired_refund', reference, slip]) : undefined
    if (!id || positiveSlips.has(hash([reference, slip])))
      review.add('cancellation_event_identity_unverified')
    if (id && ids.has(id)) {
      review.add('duplicate_source_identity')
      covered = false
      issues.add('duplicate_source_identity')
      for (const previous of rows.filter((row) => row.cancellationEventId === id))
        previous.needsReview = [...new Set([...previous.needsReview, 'duplicate_source_identity'])]
    }
    if (id) ids.add(id)
    rows.push({
      ...identity,
      sourceId: `hyundai_card:${id ?? hash([identity.sourceId, queryDate, magnitude])}`,
      kind: 'cancellation',
      approvedAt,
      queryDate,
      eventDate: queryDate,
      amount: 0,
      originalAmountKnown: false,
      status: 'cancelled',
      cancellationAmount: validAmount ? magnitude : null,
      cancellationAmountType: 'event',
      ...(id ? { cancellationEventId: id } : {}),
      // Repeat-query stability below is required before any row receives proof.
      cancellationEvidence: false,
      netAmount: null,
      needsReview: [...review]
    })
  }
  return { rows, items, count: items.length, total, covered, issues: [...issues] }
}

/** Bounded official API22 queries. No agent inference, cookie export or paid API. */
export const collectHyundaiCancellationApi: CardApiCollector = async (tab, range, options = {}) => {
  const started = Date.now()
  const rows: CardApiRow[] = []
  const issues = new Set<string>()
  let pages = 0
  let coverage = true
  const result = (): CardApiResult => ({
    rows,
    receipt: {
      issuer: 'hyundai_card' as const,
      range,
      pages,
      rowCount: rows.length,
      complete: false,
      approvalComplete: false,
      cancellationComplete: false,
      statusComplete: false,
      cancellationQueryComplete: coverage,
      cancellationQueryBasis: 'issuer_display_date' as const,
      issues: [...issues],
      elapsedMs: Date.now() - started
    }
  })
  const wc = tab.view.webContents
  const url = wc.getURL()
  const profile = tab.profile
  const stop = (): void => {
    if (
      options.signal?.aborted ||
      wc.isDestroyed() ||
      tab.view.webContents !== wc ||
      tab.profile !== profile ||
      wc.getURL() !== url
    )
      throw new Error('navigation_or_session_changed')
  }
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000)
  const maxPages = Math.min(100, Math.max(0, Math.floor(options.maxPages ?? 100)))
  try {
    const days = dailyCardRanges(range)
    if (!historyOrigin(url)) throw new Error('history_page_required')
    if ((await pageBridge.hyundaiAuth(tab)).state !== 'signed_in')
      throw new Error('authentication_required')
    const query = async (
      form: HyundaiApiForm,
      iso: string,
      tails: HyundaiCardTail[]
    ): Promise<AcquiredPage> => {
      stop()
      if (signal.aborted) throw new Error('query_cancelled')
      if (pages >= maxPages) throw new Error('page_limit')
      pages++
      const response = await requestHyundaiApiPage(tab, form, signal, 'acquired')
      stop()
      const scope = responseScopeIssue(response, form, iso, 'acquired')
      if (scope) throw new Error(scope)
      return parseHyundaiCancellationPage(response, iso, tails)
    }
    const boundedPage = async (
      form: HyundaiApiForm,
      iso: string,
      tails: HyundaiCardTail[]
    ): Promise<AcquiredPage> => {
      const page = await query(form, iso, tails)
      if (page.covered || Math.max(page.count ?? 0, page.total ?? 0) < 630) return page
      const references = tails.filter((entry) => entry.queryable).map((entry) => entry.crno)
      if (
        !references.length ||
        references.length > 10 ||
        new Set(references).size !== references.length ||
        references.includes(form.crno)
      )
        return page
      const parts: AcquiredPage[] = []
      for (const reference of references) {
        const part = await query({ ...form, crno: reference }, iso, tails)
        if (part.items.some((item) => scalar(own(item, 'crno'), 128) !== reference)) {
          part.covered = false
          part.issues.push('card_split_row_scope_unverified')
        }
        parts.push(part)
      }
      const count = parts.reduce((sum, part) => sum + (part.count ?? 0), 0)
      const combined = parts.flatMap((part) => part.rows)
      const unique = new Set(combined.map((row) => row.sourceId)).size === combined.length
      const valid = parts.every((part) => part.covered) && count === page.total && unique
      if (!valid) {
        issues.add('card_split_total_mismatch')
        return page
      }
      issues.add('card_split_verified')
      return {
        rows: combined,
        items: parts.flatMap((part) => part.items),
        count,
        total: count,
        covered: true,
        issues: parts.flatMap((part) => part.issues)
      }
    }
    for (const day of days) {
      stop()
      const plan: unknown = await initialRequestPlan(
        tab,
        wc,
        url,
        requestPlanScript(day.from, day.to, 'acquired'),
        signal
      )
      stop()
      if (own(plan, 'ok') !== true) throw new Error('request_schema_unverified')
      const form = own(plan, 'data') as HyundaiApiForm
      const tails = own(plan, 'cardTails') as HyundaiCardTail[]
      if (
        !form ||
        !Array.isArray(tails) ||
        form.dmfrClsf !== '' ||
        date(form.srtDt) !== day.from ||
        date(form.endDt) !== day.to
      )
        throw new Error('scope_unverified')
      const first = await boundedPage(form, day.from, tails)
      const second = await boundedPage(form, day.from, tails)
      const snapshot = (page: AcquiredPage): string =>
        JSON.stringify(page.rows.map((row) => JSON.stringify(row)).sort())
      const stable =
        first.covered &&
        second.covered &&
        first.total === second.total &&
        snapshot(first) === snapshot(second)
      if (!stable) {
        coverage = false
        issues.add('acquired_snapshot_unverified')
      }
      for (const issue of first.issues) issues.add(issue)
      for (const row of first.rows) {
        row.cancellationEvidence = stable && row.needsReview.length === 0
        if (!stable) row.needsReview.push('cancellation_event_identity_unverified')
        rows.push(row)
      }
    }
    stop()
    if ((await pageBridge.hyundaiAuth(tab)).state !== 'signed_in')
      throw new Error('authentication_required')
    stop()
  } catch (error) {
    coverage = false
    const code =
      error instanceof Error && /^[a-z_]{1,80}$/.test(error.message)
        ? error.message
        : 'cancellation_query_unavailable'
    issues.add(code)
  }
  return result()
}
