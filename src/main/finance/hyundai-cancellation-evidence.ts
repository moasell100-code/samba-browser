import { createHash } from 'node:crypto'
import type { Tab } from '../browser/tab-manager'
import { pageBridge } from '../browser/page-bridge'
import type { CardDateRange } from './card-api-types'
import { dailyCardRanges, recentCardDateRange } from './card-date-range'
import {
  own,
  scalar,
  date,
  dateTime,
  historyOrigin,
  initialRequestPlan,
  requestPlanScript,
  requestHyundaiApiPage,
  responseScopeIssue,
  type HyundaiApiForm
} from './hyundai-api-collector'

const MAX_ROWS = 1000
const RUN_MS = 120_000
const REQUEST_MS = 21_000
const MONEY_MAX = 999_999_999_999
const ISSUES = [
  'invalid_range',
  'history_page_required',
  'authentication_required',
  'navigation_changed',
  'cancelled',
  'run_time_limit',
  'request_timeout',
  'request_schema_unverified',
  'scope_unverified',
  'scope_changed',
  'response_range_unverified',
  'response_scope_unverified',
  'response_schema_unverified',
  'service_error',
  'total_count_unverified',
  'total_count_mismatch',
  'daily_row_limit_possible',
  'repeat_snapshot_changed',
  'repeat_identity_unverified',
  'probe_unavailable'
] as const
type Issue = (typeof ISSUES)[number]

export interface HyundaiCancellationEvidenceCounts {
  rows: number
  cancellationFlagY: number
  minusPrefix: number
  flagAndMinus: number
  flagWithoutMinus: number
  minusWithoutFlag: number
  numericComponentsValid: number
  numericComponentsInvalid: number
  displayedNegative: number
  displayedNonnegative: number
  displayedAmountInvalid: number
  refundRows: number
  refundSlipNoPresent: number
  refundSlipNoMissing: number
  refundSlipNoUniqueRows: number
  refundSlipNoDuplicateRows: number
  refundSlipNoMatchesPositiveRows: number
  refundUseDateValid: number
  refundUseDateMatchesRequest: number
  refundApprovalDateValid: number
  refundApprovalDateTimeValid: number
  refundApprovalDatesAgree: number
  refundApprovalAfterUseDate: number
  refundOriginalIdentityComplete: number
  refundApprovalNumberMissing: number
  refundCardReferenceMissing: number
  refundNormalizedCardTailMissing: number
  refundCardTailMissing: number
  refundMerchantMissing: number
}
export interface HyundaiCancellationEvidence {
  state: 'ready' | 'partial' | 'unavailable' | 'invalid_range'
  dateBasis: 'unverified'
  eventIdentity: 'unverified'
  pages: number
  scopeVerified: boolean
  reportedTotal: number | null
  counts: HyundaiCancellationEvidenceCounts
  repeat: {
    comparedDays: number
    stableDays: number
    changedDays: number
    identityUnverifiedDays: number
  }
  issues: Issue[]
}
function blankCounts(): HyundaiCancellationEvidenceCounts {
  return {
    rows: 0,
    cancellationFlagY: 0,
    minusPrefix: 0,
    flagAndMinus: 0,
    flagWithoutMinus: 0,
    minusWithoutFlag: 0,
    numericComponentsValid: 0,
    numericComponentsInvalid: 0,
    displayedNegative: 0,
    displayedNonnegative: 0,
    displayedAmountInvalid: 0,
    refundRows: 0,
    refundSlipNoPresent: 0,
    refundSlipNoMissing: 0,
    refundSlipNoUniqueRows: 0,
    refundSlipNoDuplicateRows: 0,
    refundSlipNoMatchesPositiveRows: 0,
    refundUseDateValid: 0,
    refundUseDateMatchesRequest: 0,
    refundApprovalDateValid: 0,
    refundApprovalDateTimeValid: 0,
    refundApprovalDatesAgree: 0,
    refundApprovalAfterUseDate: 0,
    refundOriginalIdentityComplete: 0,
    refundApprovalNumberMissing: 0,
    refundCardReferenceMissing: 0,
    refundNormalizedCardTailMissing: 0,
    refundCardTailMissing: 0,
    refundMerchantMissing: 0
  }
}
class Stopped extends Error {
  constructor(readonly issue: Issue) {
    super(issue)
  }
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function token(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value)))
    return null
  const text = scalar(value, maximum)
  return text &&
    ![...text].some((letter) => letter.charCodeAt(0) < 32 || letter.charCodeAt(0) === 127)
    ? text
    : null
}
function slipDigest(value: unknown): string | null {
  const text = token(value, 128)
  return text && text !== '0' && !/^[-*]+$/.test(text)
    ? digest(['hyundai_card', 'acquired_slip', text])
    : null
}
/** Match the observed Number(useAmt) + Number(excm), not a comma-stripping approximation. */
function numeric(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !/^-?\d+(?:\.0+)?$/.test(value.trim())) return null
  const number = Number(value)
  return Number.isSafeInteger(number) && Math.abs(number) <= MONEY_MAX ? number : null
}
function amounts(row: unknown): { base: number | null; displayed: number | null } {
  const principal = numeric(own(row, 'useAmt'))
  const fee = numeric(own(row, 'excm'))
  if (principal === null || fee === null) return { base: null, displayed: null }
  const base = principal + fee
  if (!Number.isSafeInteger(base) || Math.abs(base) > MONEY_MAX)
    return { base: null, displayed: null }
  // recentList prepends calnMarkVl to formatComma(avAmt). A double minus is invalid.
  const mark = own(row, 'calnMarkVl')
  if (mark === '') return { base, displayed: base }
  if (mark === '+' && base >= 0) return { base, displayed: base }
  if (mark === '-' && base > 0) return { base, displayed: -base }
  return { base, displayed: null }
}
function normalizedCardNumber(row: unknown): string | null {
  const number = token(own(row, 'cdno'), 128)
    ?.replace(/[ -]/g, '')
    .replace(/[*Xx●•]/g, '*')
  return number && /^[\d*]{15,16}$/.test(number) ? number : null
}
function normalizedCardTail(row: unknown): string | null {
  const number = normalizedCardNumber(row)
  return number && /\d/.test(number.slice(-4)) ? number.slice(-4) : null
}
function cardTail(row: unknown, plan: unknown): string | null {
  const normalized = normalizedCardTail(row)
  if (normalized) return normalized
  const reference = token(own(row, 'crno'), 128)
  const candidates = own(plan, 'cardTails')
  if (!reference || !Array.isArray(candidates)) return null
  const matches = candidates.filter((entry) => own(entry, 'crno') === reference)
  const suffix = matches.length === 1 ? own(matches[0], 'last4') : null
  return matches.length === 1 &&
    own(matches[0], 'status') === 'matched' &&
    typeof suffix === 'string' &&
    /^[\d*]{4}$/.test(suffix) &&
    /\d/.test(suffix)
    ? suffix
    : null
}
type Snapshot = {
  rows: number
  total: number | null
  refundSemantics: Map<string, string>
  identityVerified: boolean
}

/** Fixed API22 diagnostics only. Hashes and raw fields are private, ephemeral comparison data.
 * Consistent signs and repeated slip numbers do not independently prove issuer ID semantics
 * or that useDt is a merchant's actual cancellation-occurrence date.
 */
export async function inspectHyundaiCancellationEvidence(
  tab: Tab,
  range: CardDateRange,
  suppliedSignal?: AbortSignal
): Promise<HyundaiCancellationEvidence> {
  const output: HyundaiCancellationEvidence = {
    state: 'unavailable',
    dateBasis: 'unverified',
    eventIdentity: 'unverified',
    pages: 0,
    scopeVerified: true,
    reportedTotal: 0,
    counts: blankCounts(),
    repeat: { comparedDays: 0, stableDays: 0, changedDays: 0, identityUnverifiedDays: 0 },
    issues: []
  }
  const issues = new Set<Issue>()
  const positiveIds = new Set<string>()
  const refundIds = new Map<string, number>()
  let days: CardDateRange[]
  try {
    days = dailyCardRanges(range)
    if (range.from < '2026-07-01' || range.to > recentCardDateRange().to) throw new Error()
  } catch {
    return { ...output, state: 'invalid_range', scopeVerified: false, issues: ['invalid_range'] }
  }
  const wc = tab.view.webContents
  const profile = tab.profile
  const initial = wc.getURL()
  if (wc.isDestroyed() || !historyOrigin(initial))
    return { ...output, scopeVerified: false, issues: ['history_page_required'] }
  const controller = new AbortController()
  let stopped: Issue = 'cancelled'
  const stop = (issue: Issue): void => {
    stopped = issue
    controller.abort()
  }
  const navigate = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean): void => {
    if (mainFrame) stop('navigation_changed')
  }
  const destroyed = (): void => stop('navigation_changed')
  const abort = (): void => stop('cancelled')
  const signal = controller.signal
  const timer = setTimeout(() => stop('run_time_limit'), RUN_MS)
  wc.on('did-start-navigation', navigate)
  wc.on('destroyed', destroyed)
  suppliedSignal?.addEventListener('abort', abort, { once: true })
  if (suppliedSignal?.aborted) abort()
  const context = (): void => {
    if (signal.aborted) throw new Stopped(stopped)
    if (
      tab.view.webContents !== wc ||
      tab.profile !== profile ||
      wc.isDestroyed() ||
      wc.getURL() !== initial
    )
      throw new Stopped('navigation_changed')
  }
  const bounded = async <T>(pending: Promise<T>): Promise<T> => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Stopped('request_timeout')), REQUEST_MS)
          onAbort = (): void => reject(new Stopped(stopped))
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        })
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }
  const auth = async (): Promise<void> => {
    context()
    const state = await bounded(pageBridge.hyundaiAuth(tab))
    context()
    if (state.state !== 'signed_in') throw new Stopped('authentication_required')
  }
  const record = (
    response: unknown,
    form: HyundaiApiForm,
    iso: string,
    plan: unknown,
    primary: boolean
  ): Snapshot => {
    const scope = responseScopeIssue(response, form, iso, 'acquired')
    if (scope) {
      output.scopeVerified = false
      if (scope === 'response_range_unverified' || scope === 'response_scope_unverified')
        issues.add(scope)
      else issues.add('scope_unverified')
    }
    const body = own(response, 'bdy') ?? response
    if (scalar(own(body, 'error_code')) && scalar(own(body, 'error_message')))
      throw new Stopped('service_error')
    const rows = own(body, 'acqrUseItmList')
    if (
      !Array.isArray(rows) ||
      rows.length > MAX_ROWS ||
      rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))
    )
      throw new Stopped('response_schema_unverified')
    const text = scalar(own(own(body, 'rcntSummaryInfo'), 'totUseCnt'), 10)
    const total =
      text && /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null
    if (total === null) issues.add('total_count_unverified')
    else if (total !== rows.length) issues.add('total_count_mismatch')
    if (Math.max(rows.length, total ?? 0) >= 630) issues.add('daily_row_limit_possible')
    if (primary) {
      if (total === null) output.reportedTotal = null
      else if (output.reportedTotal !== null) output.reportedTotal += total
    }
    const snapshot: Snapshot = {
      rows: rows.length,
      total,
      refundSemantics: new Map(),
      identityVerified: true
    }
    for (const row of rows) {
      const flag = own(row, 'cancYn') === 'Y'
      const minus = own(row, 'calnMarkVl') === '-'
      const { base, displayed } = amounts(row)
      const refunded = flag && displayed !== null && displayed < 0
      const id = slipDigest(own(row, 'slipNo'))
      if (displayed !== null && displayed > 0 && id) positiveIds.add(id)
      if (primary) {
        const counts = output.counts
        counts.rows++
        if (flag) counts.cancellationFlagY++
        if (minus) counts.minusPrefix++
        if (flag && minus) counts.flagAndMinus++
        if (flag && !minus) counts.flagWithoutMinus++
        if (minus && !flag) counts.minusWithoutFlag++
        counts[base === null ? 'numericComponentsInvalid' : 'numericComponentsValid']++
        counts[
          displayed === null
            ? 'displayedAmountInvalid'
            : displayed < 0
              ? 'displayedNegative'
              : 'displayedNonnegative'
        ]++
      }
      // Positive Y postings are not refund events and must not invalidate other refund IDs.
      if (!refunded) continue
      if (!id || snapshot.refundSemantics.has(id)) snapshot.identityVerified = false
      const used = date(own(row, 'useDt'))
      const approved = date(own(row, 'avDt'))
      const approvedTime = dateTime(own(row, 'avDttm'))
      const reference = token(own(row, 'crno'), 128)
      const number = token(own(row, 'cdno'), 128)
      const merchant = token(own(row, 'useMrchNm'), 255) || token(own(row, 'mrchNm'), 255)
      const approval = token(own(row, 'avNo'), 80)
      const tail = cardTail(row, plan)
      if (id)
        snapshot.refundSemantics.set(
          id,
          digest([
            used,
            approved,
            approvedTime,
            reference,
            number,
            merchant,
            token(own(row, 'useMrchNm'), 500),
            token(own(row, 'mrchNm'), 500),
            approval,
            tail,
            numeric(own(row, 'useAmt')),
            numeric(own(row, 'excm')),
            base,
            displayed,
            flag,
            minus
          ])
        )
      if (!primary || !refunded) continue
      const counts = output.counts
      counts.refundRows++
      if (id) {
        counts.refundSlipNoPresent++
        refundIds.set(id, (refundIds.get(id) ?? 0) + 1)
      } else counts.refundSlipNoMissing++
      if (used) counts.refundUseDateValid++
      if (used === iso) counts.refundUseDateMatchesRequest++
      if (approved) counts.refundApprovalDateValid++
      if (approvedTime?.includes('T')) counts.refundApprovalDateTimeValid++
      const datesAgree = !!approved && !!approvedTime && approved === approvedTime.slice(0, 10)
      if (datesAgree) counts.refundApprovalDatesAgree++
      const afterUse =
        !!used &&
        ((!!approved && approved > used) || (!!approvedTime && approvedTime.slice(0, 10) > used))
      if (afterUse) counts.refundApprovalAfterUseDate++
      const approvalComplete = !!approval && /^\d{6,8}$/.test(approval)
      if (!approvalComplete) counts.refundApprovalNumberMissing++
      if (!reference) counts.refundCardReferenceMissing++
      if (!normalizedCardTail(row)) counts.refundNormalizedCardTailMissing++
      if (!tail) counts.refundCardTailMissing++
      if (!merchant) counts.refundMerchantMissing++
      if (
        used &&
        datesAgree &&
        approvedTime?.includes('T') &&
        !afterUse &&
        approvalComplete &&
        (reference || normalizedCardNumber(row)) &&
        tail &&
        merchant
      )
        counts.refundOriginalIdentityComplete++
    }
    return snapshot
  }
  try {
    await auth()
    for (const day of days) {
      const iso = day.from
      const script = requestPlanScript(iso, iso, 'acquired')
      const snapshots: Snapshot[] = []
      let planSnapshot: string | undefined
      for (let repeat = 0; repeat < 2; repeat++) {
        await auth()
        const plan = await bounded(
          output.pages === 0
            ? initialRequestPlan(tab, wc, initial, script, signal)
            : wc.executeJavaScript(script, false)
        )
        context()
        const form = own(plan, 'data') as HyundaiApiForm
        if (
          own(plan, 'ok') !== true ||
          !form ||
          date(form.srtDt) !== iso ||
          date(form.endDt) !== iso
        )
          throw new Stopped('request_schema_unverified')
        if (form.dmfrClsf !== '') {
          output.scopeVerified = false
          issues.add('scope_unverified')
        }
        const currentPlan = digest([form, own(plan, 'cardTails')])
        if (planSnapshot && planSnapshot !== currentPlan) throw new Stopped('scope_changed')
        planSnapshot = currentPlan
        context()
        output.pages++
        const response = await bounded(requestHyundaiApiPage(tab, form, signal, 'acquired'))
        await auth()
        snapshots.push(record(response, form, iso, plan, repeat === 0))
      }
      output.repeat.comparedDays++
      const [first, second] = snapshots
      if (!first.identityVerified || !second.identityVerified) {
        output.repeat.identityUnverifiedDays++
        issues.add('repeat_identity_unverified')
      } else if (
        first.rows !== second.rows ||
        first.total !== second.total ||
        first.refundSemantics.size !== second.refundSemantics.size ||
        [...first.refundSemantics].some(
          ([id, semantics]) => second.refundSemantics.get(id) !== semantics
        )
      ) {
        output.repeat.changedDays++
        issues.add('repeat_snapshot_changed')
      } else output.repeat.stableDays++
    }
    output.state = issues.size ? 'partial' : 'ready'
  } catch (error) {
    output.scopeVerified = false
    const safeShared: Record<string, Issue> = {
      hyundai_authentication_required: 'authentication_required',
      hyundai_navigation_changed: 'navigation_changed',
      hyundai_request_cancelled: 'cancelled',
      hyundai_request_timeout: 'request_timeout'
    }
    const issue =
      error instanceof Stopped
        ? error.issue
        : signal.aborted
          ? stopped
          : error instanceof Error
            ? (safeShared[error.message] ??
              (ISSUES.includes(error.message as Issue)
                ? (error.message as Issue)
                : 'probe_unavailable'))
            : 'probe_unavailable'
    issues.add(issue)
    output.state = output.pages ? 'partial' : 'unavailable'
  } finally {
    clearTimeout(timer)
    suppliedSignal?.removeEventListener('abort', abort)
    wc.removeListener('did-start-navigation', navigate)
    wc.removeListener('destroyed', destroyed)
    controller.abort()
  }
  for (const [id, appearances] of refundIds) {
    output.counts[appearances === 1 ? 'refundSlipNoUniqueRows' : 'refundSlipNoDuplicateRows'] +=
      appearances
    if (positiveIds.has(id)) output.counts.refundSlipNoMatchesPositiveRows += appearances
  }
  if (output.counts.refundSlipNoDuplicateRows || output.counts.refundSlipNoMatchesPositiveRows) {
    issues.add('repeat_identity_unverified')
    if (output.state === 'ready') output.state = 'partial'
  }
  output.issues = [...issues]
  return output
}
