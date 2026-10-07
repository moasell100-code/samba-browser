import { createHash } from 'node:crypto'
import { parse, type HTMLElement, type Node } from 'node-html-parser'
import { pageBridge } from '../browser/page-bridge'
import type { Tab } from '../browser/tab-manager'
import type { CardApiCollector, CardApiResult, CardApiRow } from './card-api-types'
import { summarizeLotteHistoryContent } from './lotte-response-summary'
import { lotteResponseShapeIssues } from './lotte-api-diagnostics'
import { lotteMethodDiagnostics } from './lotte-method-diagnostics'
import { lotteCardIdentityDiagnostics } from './lotte-card-identity-diagnostics'

const HISTORY = 'https://www.lottecard.co.kr/app/LPMCDAA_V100.lc'
const QUERY = 'https://www.lottecard.co.kr/app/LPMCDAA_A102.lc'
const DETAIL_QUERY = 'https://www.lottecard.co.kr/app/LPMCDAA_P103.lc'
const REQUEST_FIELDS = [
  'encCdno',
  'endDt',
  'inqTeDt',
  'nextKey',
  'pageNo',
  'pageRows',
  'ptnBnkYn',
  'schDv',
  'sortDv',
  'sortObj',
  'stDv',
  'startDt',
  'uplDv',
  'useCdDv',
  'useDv'
] as const
export type LotteApiForm = Readonly<Record<(typeof REQUEST_FIELDS)[number], string>>
const DETAIL_FIELDS = [
  'aprDeAm',
  'aprDeKeyV',
  'aprDtti',
  'encCdno',
  'deDt',
  'gramFlwSeq',
  'auPartId',
  'aprno',
  'aprTrc',
  'byRc',
  'byCanRc',
  'mcNm',
  'lono',
  'type',
  'mildolYn',
  'aprRsc'
] as const
type DetailFields = ReadonlyMap<string, string>
type CardIdentity = { cardKey: string; cardLast4: string }
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const DETAIL_LABELS = [
  '이용일시',
  '거래유형',
  '승인번호',
  '취소여부',
  '포인트사용',
  '매입여부',
  '취소금액',
  '매입금액',
  '취소일자'
] as const
const DETAIL_METHOD_LABELS = [
  '신용',
  '체크',
  '신용거래',
  '체크거래',
  '신용승인',
  '체크승인',
  '신용카드',
  '체크카드',
  '승인',
  '구매',
  '물품구매',
  '일시불',
  '할부',
  '일시불승인',
  '일시불(국내)',
  '일시불(해외)',
  '국내승인',
  '해외승인',
  '정상승인',
  '신용판매',
  '체크판매',
  '신용구매',
  '일시불판매',
  '신용판매(일시불)',
  '신용판매(할부)',
  '일시불 승인',
  '카드승인',
  '국내일시불',
  '해외일시불',
  '일반',
  '법인',
  '선불',
  '후불',
  '비씨',
  'BC',
  'BC신용',
  '신용(BC)',
  '체크(BC)',
  '체크(비씨)',
  '신용(비씨)',
  '기프트'
] as const
const CANCELLATION_EXTRA_LABELS = [
  '',
  '-',
  '--',
  '해당없음',
  '취소아님',
  '취소안됨',
  '정상승인',
  '승인',
  '승인완료'
] as const
const MAX_TEXT = 2000
const REQUEST_MS = 20_000
const SAFE_ERRORS = new Set([
  'lotte_request_cancelled',
  'lotte_navigation_changed',
  'lotte_authentication_required',
  'lotte_request_timeout',
  'lotte_request_invalid',
  'lotte_history_required',
  'lotte_response_unavailable',
  'lotte_response_limit',
  'lotte_request_unavailable'
])

async function bounded<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new Error('lotte_request_cancelled')
  let timeout: ReturnType<typeof setTimeout> | undefined
  let abort: () => void = () => {}
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error('lotte_request_cancelled'))
        timeout = setTimeout(() => reject(new Error('lotte_request_timeout')), REQUEST_MS)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
    ])
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

export interface LotteApiPage {
  rows: CardApiRow[]
  issues: string[]
  rowCount: number | null
}

function own(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined
}
function elements(node: Node): HTMLElement[] {
  return node.childNodes.filter((child): child is HTMLElement => child.nodeType === 1)
}
/** Server-rendered business text only; never read form values, event handlers, script, or HTML. */
function text(node: Node): string | null {
  let result = ''
  let visited = 0
  const visit = (current: Node): void => {
    if (++visited > 200 || result.length > MAX_TEXT) throw new Error('text_limit')
    if (current.nodeType === 3) {
      result += current.text
      return
    }
    if (current.nodeType !== 1) return
    const element = current as HTMLElement
    if (
      ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT'].includes(
        element.tagName
      ) ||
      element.hasAttribute('contenteditable')
    )
      return
    for (const child of element.childNodes) visit(child)
  }
  try {
    visit(node)
  } catch {
    return null
  }
  return result.length <= MAX_TEXT ? result.replace(/\s+/g, ' ').trim() : null
}
function date(value: string): string | null {
  const found =
    /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})\.?\s*(?:(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(
      value.trim()
    )
  if (!found) return null
  const [, y, m, d, hour, minute, second] = found
  const [year, month, day] = [Number(y), Number(m), Number(d)]
  const check = new Date(Date.UTC(year, month - 1, day))
  if (
    year < 2000 ||
    year > 2100 ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  )
    return null
  const dayText = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  if (hour === undefined) return dayText
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second ?? 0) > 59) return null
  return `${dayText}T${hour.padStart(2, '0')}:${minute}:${second ?? '00'}+09:00`
}
function krw(value: string | undefined): number | null {
  if (value === undefined) return null
  const normalized = value.replace(/\s+/g, '')
  if (!/^(?:₩)?[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:원)?$/.test(normalized)) return null
  const amount = Number(normalized.replace(/[₩,원]/g, ''))
  return Number.isSafeInteger(amount) && Math.abs(amount) <= 999_999_999_999 ? amount : null
}
function detailFields(row: HTMLElement): Map<string, string> | null {
  const boxes = elements(row).filter(
    (node) => node.tagName === 'DIV' && node.classList.contains('useList')
  )
  if (boxes.length !== 1) return null
  const lists = elements(boxes[0]).filter((node) => node.tagName === 'UL')
  if (lists.length !== 1) return null
  return detailListFields(lists[0])
}
function detailListFields(list: HTMLElement): Map<string, string> | null {
  const pairs = elements(list)
  if (
    pairs.length < DETAIL_LABELS.length ||
    pairs.length > DETAIL_LABELS.length + 2 ||
    pairs.some((node) => node.tagName !== 'LI')
  )
    return null
  const result = new Map<string, string>()
  let requiredIndex = 0
  for (const pair of pairs) {
    const label = pair.childNodes
      .filter((node) => node.nodeType === 3)
      .map((node) => node.text)
      .join('')
      .replace(/\s+/g, '')
      .trim()
    const values = elements(pair).filter((node) => node.tagName === 'SPAN')
    if (values.length !== 1) return null
    if (label !== '업종' && label !== '분야') {
      if (label !== DETAIL_LABELS[requiredIndex]) return null
      requiredIndex += 1
    }
    const value = text(values[0])
    if (value === null) return null
    const previous = result.get(label)
    result.set(label, previous && value && previous !== value ? '' : previous || value)
  }
  if (requiredIndex !== DETAIL_LABELS.length) return null
  return result
}
function rowFromHtml(
  row: HTMLElement,
  verifiedDetails?: DetailFields,
  verifiedCard?: CardIdentity
): CardApiRow | null {
  const children = elements(row)
  const heading = children.find((node) => node.tagName === 'STRONG')!
  const info = children.find((node) => node.tagName === 'DIV' && node.classList.contains('info'))!
  const money = children.find((node) => node.tagName === 'EM')!
  const metadata = elements(info).map(text)
  const amounts = elements(money).map(text)
  const merchant = text(heading)
  const headDate = metadata[0] && date(metadata[0])
  const cardLabel = metadata[1]
  const headAmount = amounts[0] === null ? null : krw(amounts[0])
  if (
    !merchant ||
    merchant.length > 255 ||
    !headDate ||
    !cardLabel ||
    cardLabel.length > 120 ||
    headAmount === null
  )
    return null
  const details = verifiedDetails ?? detailFields(row)
  const needsReview: string[] = []
  if (!details) needsReview.push('details_unverified')
  if (!/[₩원]/.test(amounts[0] ?? '')) needsReview.push('currency_unverified')
  const method = metadata[2]
  if (method !== '일시불' && method !== '할부') needsReview.push('transaction_type_unverified')
  const detailMethod = details?.get('거래유형')
  const instrument = detailMethod?.replace(/\s+/g, '')
  const detailMethodCompatible =
    detailMethod === method ||
    (['신용', '체크', '신용승인', '체크승인'].includes(instrument ?? '') &&
      (method === '일시불' || method === '할부'))
  if (detailMethod && !detailMethodCompatible) {
    needsReview.push('transaction_type_conflict')
    const label = (DETAIL_METHOD_LABELS as readonly string[]).indexOf(detailMethod)
    needsReview.push(
      label >= 0 ? `detail_method_label_${label}` : 'detail_method_label_unrecognized'
    )
    needsReview.push(...lotteMethodDiagnostics(detailMethod))
  }
  const detailDate = details?.get('이용일시') ? date(details.get('이용일시')!) : null
  const approvedAt = detailDate ?? headDate
  if (detailDate && detailDate.slice(0, 10) !== headDate.slice(0, 10))
    needsReview.push('approval_date_conflict')
  const approvalText = details?.get('승인번호')
  const approvalNumber =
    approvalText && /^[A-Za-z0-9-]{1,80}$/.test(approvalText) && !/^-+$/.test(approvalText)
      ? approvalText
      : undefined
  const cardMatch = /\((\d{4})\)$/.exec(cardLabel)
  const cardLast4 = verifiedCard?.cardLast4 ?? cardMatch?.[1]
  if (verifiedCard && cardMatch && verifiedCard.cardLast4 !== cardMatch[1])
    needsReview.push('card_identity_conflict')
  if (!approvalNumber || !cardLast4) needsReview.push('identity_unverified')
  let status: CardApiRow['status'] = 'approved'
  if (row.classList.contains('cancel')) {
    status = metadata[3] === '취소' ? 'cancelled' : 'unknown'
  } else if (money.classList.contains('parttot')) {
    status =
      metadata[3] === '부분취소' ||
      /^부분취소\(-(?:\d+|\d{1,3}(?:,\d{3})+)원\)$/.test(metadata[3] ?? '')
        ? 'partially_cancelled'
        : 'unknown'
  }
  if (status === 'unknown') needsReview.push('status_unverified')
  if (headAmount < 0 && status === 'approved') {
    status = 'unknown'
    needsReview.push('negative_approval_amount')
  }
  const amount = Math.abs(headAmount)
  let cancellationAmount: number | null = null
  let netAmount: number | null = status === 'approved' ? amount : null
  const cancellationDate = details?.get('취소일자') ? date(details.get('취소일자')!) : null
  const detailRefund = krw(details?.get('취소금액'))
  const cancellationLabel = details?.get('취소여부')
  const normalDash =
    cancellationLabel === '-' &&
    status === 'approved' &&
    (detailRefund === 0 || ['', '-', '--'].includes(details?.get('취소금액') ?? '')) &&
    ['', '-', '--'].includes(details?.get('취소일자') ?? '')
  if (
    details &&
    cancellationLabel !== '정상' &&
    !normalDash &&
    !['취소', '취소완료', '부분취소'].includes(cancellationLabel ?? '')
  ) {
    needsReview.push('status_unverified')
    const label = ['없음', '미취소', 'N', 'Y'].indexOf(cancellationLabel ?? '')
    const extra = (CANCELLATION_EXTRA_LABELS as readonly string[]).indexOf(cancellationLabel ?? '')
    needsReview.push(
      label >= 0
        ? `cancellation_label_${label}`
        : extra >= 0
          ? `cancellation_extra_label_${extra}`
          : 'cancellation_label_unrecognized'
    )
  }
  if (
    status === 'approved' &&
    (['취소', '취소완료', '부분취소'].includes(cancellationLabel ?? '') ||
      (detailRefund !== null && detailRefund !== 0) ||
      cancellationDate)
  ) {
    status = 'unknown'
    netAmount = null
    needsReview.push('cancellation_state_conflict')
  } else if (status !== 'approved' && cancellationLabel === '정상') {
    needsReview.push('cancellation_state_conflict')
  }
  if (status === 'cancelled' || status === 'partially_cancelled') {
    const explicitRefund = krw(details?.get('취소금액'))
    const statusRefund = /^부분취소\(-((?:\d+|\d{1,3}(?:,\d{3})+))원\)$/.exec(metadata[3] ?? '')
    const statusAmount = statusRefund ? krw(statusRefund[1]) : null
    if (explicitRefund !== null) cancellationAmount = Math.abs(explicitRefund)
    else if (statusAmount !== null) cancellationAmount = statusAmount
    if (statusAmount !== null && cancellationAmount !== statusAmount) {
      cancellationAmount = null
      needsReview.push('cancellation_amount_conflict')
    }
    if (cancellationAmount === null || cancellationAmount <= 0 || cancellationAmount > amount) {
      needsReview.push('cancellation_amount_unverified')
    } else if (status === 'cancelled' && cancellationAmount !== amount) {
      needsReview.push('cancellation_amount_conflict')
    } else {
      netAmount = amount - cancellationAmount
    }
    if (!cancellationDate) needsReview.push('cancellation_date_unverified')
    if (status === 'partially_cancelled') {
      // The two unlabelled header amounts must not establish original/refund semantics.
      needsReview.push('partial_original_amount_unverified')
      netAmount = null
    }
  }
  const identity =
    approvalNumber && cardLast4
      ? ['lotte_card', verifiedCard?.cardKey ?? cardLast4, approvedAt.slice(0, 10), approvalNumber]
      : ['lotte_card', 'unverified', cardLabel, approvedAt, merchant, amount]
  const industries = new Set(
    [details?.get('업종'), details?.get('분야')].map((value) => value?.trim()).filter(Boolean)
  )
  const industry = industries.values().next().value
  return {
    issuer: 'lotte_card',
    sourceId: `lotte:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`,
    kind: status === 'approved' ? 'approval' : 'status',
    approvedAt,
    ...(cancellationDate ? { eventDate: cancellationDate.slice(0, 10) } : {}),
    ...(approvalNumber ? { approvalNumber } : {}),
    ...(cardLast4 ? { cardLast4 } : {}),
    ...(verifiedCard ? { cardKey: verifiedCard.cardKey } : {}),
    cardLabel,
    merchant,
    ...(industries.size === 1 && industry && industry.length <= 200
      ? { merchantIndustry: industry }
      : {}),
    amount,
    currency: 'KRW',
    status,
    cancellationAmount,
    ...(status !== 'approved' &&
    status !== 'unknown' &&
    netAmount !== null &&
    cancellationDate &&
    needsReview.length === 0
      ? { cancellationEvidence: true, cancellationAmountType: 'cumulative' as const }
      : {}),
    netAmount,
    needsReview
  }
}

/** Private normalized rows only. The caller must return receipt metadata, never this payload, to MCP. */
export function parseLotteApiResponse(
  parsed: unknown,
  detailOverrides: ReadonlyMap<number, DetailFields> = new Map(),
  detailIssues: ReadonlyMap<number, string> = new Map(),
  cardOverrides: ReadonlyMap<number, CardIdentity> = new Map()
): LotteApiPage {
  const status = own(own(parsed, 'Status'), 'code')
  if (status !== 0 && status !== '0')
    return { rows: [], issues: ['response_status_unverified'], rowCount: null }
  const summary = summarizeLotteHistoryContent(parsed)
  if (summary.root === 'unrecognized')
    return { rows: [], issues: ['response_schema_unverified'], rowCount: null }
  if (summary.root === 'empty') return { rows: [], issues: [], rowCount: 0 }
  const content = own(parsed, 'Content') as string
  const doc = parse(content)
  const root = summary.root === 'full' ? doc.querySelector('#useCardList')! : doc
  const rows: CardApiRow[] = []
  const issues = new Set<string>()
  for (const [index, element] of elements(root).entries()) {
    const row = rowFromHtml(element, detailOverrides.get(index), cardOverrides.get(index))
    if (!row) {
      issues.add('unrecognized_rows')
      continue
    }
    const detailIssue = detailIssues.get(index)
    if (detailIssue) row.needsReview.push(detailIssue)
    rows.push(row)
  }
  const seen = new Map<string, CardApiRow>()
  for (const row of rows) {
    const previous = seen.get(row.sourceId)
    if (previous) {
      previous.needsReview.push('duplicate_identity_in_page')
      row.needsReview.push('duplicate_identity_in_page')
      issues.add('duplicate_identity_in_page')
    } else seen.set(row.sourceId, row)
  }
  return { rows, issues: [...issues], rowCount: summary.rowCount }
}

function historyUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return !url.username && !url.password && url.origin + url.pathname === HISTORY
  } catch {
    return false
  }
}

/** Main-only transport. All request field values and response rows remain private. */
export async function requestLotteApiPage(
  tab: Tab,
  form: LotteApiForm,
  signal?: AbortSignal
): Promise<unknown> {
  return requestLotteForm(tab, form, 'list', signal)
}

/** Both endpoints and their request field allowlists are fixed, never caller supplied. */
async function requestLotteForm(
  tab: Tab,
  form: Readonly<Record<string, string>>,
  kind: 'list' | 'detail',
  signal?: AbortSignal
): Promise<unknown> {
  if (signal?.aborted) throw new Error('lotte_request_cancelled')
  const fields: readonly string[] = kind === 'list' ? REQUEST_FIELDS : DETAIL_FIELDS
  const endpoint = kind === 'list' ? QUERY : DETAIL_QUERY
  const keys = Object.keys(form)
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key)))
    throw new Error('lotte_request_invalid')
  const body = new URLSearchParams()
  for (const name of fields) {
    const value = own(form, name)
    const limit =
      name === 'nextKey' ? 8192 : name === 'encCdno' ? 2048 : name === 'mcNm' ? 512 : 128
    if (
      typeof value !== 'string' ||
      value.length > limit ||
      [...value].some((character) => character.charCodeAt(0) < 32)
    )
      throw new Error('lotte_request_invalid')
    body.set(name, value)
  }
  const wc = tab.view.webContents
  if (!wc || wc.isDestroyed() || !historyUrl(wc.getURL())) throw new Error('lotte_history_required')
  const initialUrl = wc.getURL()
  const assertContext = (): void => {
    if (signal?.aborted) throw new Error('lotte_request_cancelled')
    if (wc.isDestroyed() || wc.getURL() !== initialUrl) throw new Error('lotte_navigation_changed')
  }
  const auth = await bounded(pageBridge.cardSession(tab), signal)
  assertContext()
  if (auth.issuer !== 'lotte_card' || auth.state !== 'signed_in')
    throw new Error('lotte_authentication_required')
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), REQUEST_MS)
  timer.unref?.()
  let response: Response | undefined
  try {
    response = await bounded(
      wc.session.fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: HISTORY
        },
        body: body.toString(),
        signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
      }),
      signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
    )
    assertContext()
    if (!response.ok || (response.url && response.url !== endpoint) || !response.body)
      throw new Error('lotte_response_unavailable')
    const length = response.headers.get('content-length')
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES))
      throw new Error('lotte_response_limit')
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let bytes = 0
    try {
      while (true) {
        assertContext()
        const chunk = await bounded(
          reader.read(),
          signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
        )
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > MAX_RESPONSE_BYTES) throw new Error('lotte_response_limit')
        chunks.push(Buffer.from(chunk.value))
      }
    } finally {
      void reader.cancel().catch(() => undefined)
    }
    assertContext()
    const finalAuth = await bounded(pageBridge.cardSession(tab), signal)
    assertContext()
    if (finalAuth.issuer !== 'lotte_card' || finalAuth.state !== 'signed_in')
      throw new Error('lotte_authentication_required')
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error) {
    if (timeout.signal.aborted && !signal?.aborted) throw new Error('lotte_request_timeout')
    throw new Error(
      error instanceof Error && SAFE_ERRORS.has(error.message)
        ? error.message
        : 'lotte_request_unavailable'
    )
  } finally {
    clearTimeout(timer)
    void response?.body?.cancel().catch(() => undefined)
  }
}

function payloadDate(value: string): string | null {
  if (/^\d{8}(?:\d{6}(?:\d{3})?)?$/.test(value)) {
    const day = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    return date(
      value.length >= 14
        ? `${day} ${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}`
        : day
    )
  }
  return date(value)
}

/** One known transaction payload within this exact row. JSON parsing never executes page code. */
function detailRequest(
  element: HTMLElement,
  row: CardApiRow,
  mildolYn: unknown
): { ok: true; form: Readonly<Record<string, string>> } | { ok: false; reason: string } {
  if (typeof mildolYn !== 'string' || mildolYn.length > 128)
    return { ok: false, reason: 'detail_default_unverified' }
  const candidates = element.querySelectorAll('[data-object]')
  if (candidates.length !== 1) return { ok: false, reason: 'detail_payload_count_unverified' }
  const button = candidates[0]
  const siblings = elements(element)
  const next = siblings[siblings.indexOf(button) + 1]
  if (button.tagName !== 'BUTTON') return { ok: false, reason: 'detail_payload_tag_unverified' }
  if (button.parentNode !== element)
    return { ok: false, reason: 'detail_payload_parent_unverified' }
  if (!next || next.tagName !== 'DIV' || !next.classList.contains('useList'))
    return { ok: false, reason: 'detail_payload_sibling_unverified' }
  const raw = candidates[0].getAttribute('data-object')!
  if (raw.length > 16000) return { ok: false, reason: 'detail_payload_limit' }
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'detail_payload_json_unverified' }
  }
  const result: Record<string, string> = {}
  for (const name of DETAIL_FIELDS) {
    if (name === 'lono' || name === 'type') {
      result[name] = ''
      continue
    }
    if (name === 'mildolYn') {
      result[name] = mildolYn
      continue
    }
    const value = own(payload, name === 'encCdno' ? 'cdno' : name)
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value)))
      return { ok: false, reason: `detail_field_type_${name}` }
    const valueText = String(value)
    const limit = name === 'encCdno' ? 2048 : name === 'mcNm' ? 512 : 128
    if (
      valueText.length > limit ||
      [...valueText].some((character) => character.charCodeAt(0) < 32)
    )
      return { ok: false, reason: `detail_field_format_${name}` }
    result[name] = valueText
  }
  const transactionCode = integer(result.aprTrc, 19)
  if (transactionCode === null) return { ok: false, reason: 'detail_transaction_code_unverified' }
  if (!result.encCdno) return { ok: false, reason: 'detail_card_reference_unverified' }
  if (!/^[A-Za-z0-9-]{1,80}$/.test(result.aprno) || /^-+$/.test(result.aprno))
    return { ok: false, reason: 'detail_approval_number_unverified' }
  const approved = payloadDate(result.aprDtti)
  if (!approved) return { ok: false, reason: 'detail_approval_date_format_unverified' }
  if (approved.slice(0, 10) !== row.approvedAt.slice(0, 10))
    return { ok: false, reason: 'detail_approval_date_conflict' }
  const amount = krw(result.aprDeAm)
  if (row.status === 'approved' && amount === null)
    return { ok: false, reason: 'detail_approval_amount_format_unverified' }
  if (row.status === 'approved' && amount !== row.amount)
    return { ok: false, reason: 'detail_approval_amount_conflict' }
  if (result.mcNm.replace(/\s+/g, ' ').trim() !== row.merchant.replace(/\s+/g, ' ').trim())
    return { ok: false, reason: 'detail_merchant_conflict' }
  return { ok: true, form: result }
}

/** P103's Content is inserted by the official callback into this row's empty div.useList. */
function detailResponseFields(response: unknown): DetailFields | null {
  const status = own(own(response, 'Status'), 'code')
  const content = own(response, 'Content')
  if (
    (status !== 0 && status !== '0') ||
    typeof content !== 'string' ||
    Buffer.byteLength(content) > MAX_RESPONSE_BYTES
  )
    return null
  const doc = parse(content)
  const roots = elements(doc)
  if (
    roots.length < 1 ||
    roots.length > 2 ||
    roots.some((root) => root.tagName !== 'UL' && root.tagName !== 'DIV')
  )
    return null
  const lists = doc.querySelectorAll('ul')
  if (lists.length !== 1 || !roots.includes(lists[0])) return null
  if (doc.childNodes.some((node) => node.nodeType === 3 && node.text.trim())) return null
  return detailListFields(lists[0])
}

async function enrichLottePage(
  tab: Tab,
  response: unknown,
  mildolYn: unknown,
  cardIdentities: ReadonlyMap<string, CardIdentity>,
  budget: { remaining: number },
  signal?: AbortSignal
): Promise<{ page: LotteApiPage; diagnostics: string[]; interruption?: string }> {
  const original = parseLotteApiResponse(response)
  if (original.rowCount === null || original.rowCount === 0)
    return { page: original, diagnostics: [] }
  const doc = parse(own(response, 'Content') as string)
  const root = doc.querySelector('#useCardList') ?? doc
  const overrides = new Map<number, DetailFields>()
  const cardOverrides = new Map<number, CardIdentity>()
  const flags = new Map<number, string>()
  const diagnostics = new Set<string>()
  let interruption: string | undefined
  for (const [index, element] of elements(root).entries()) {
    const row = rowFromHtml(element)
    if (!row || !row.needsReview.includes('details_unverified')) continue
    // Loans and unknown payment types have a different official detail workflow.
    if (row.needsReview.includes('transaction_type_unverified')) continue
    const prepared = detailRequest(element, row, mildolYn)
    if (!prepared.ok) {
      flags.set(index, 'detail_request_unverified')
      diagnostics.add(prepared.reason)
      continue
    }
    const form = prepared.form
    if (budget.remaining <= 0) {
      interruption = 'detail_request_limit'
      flags.set(index, interruption)
      break
    }
    budget.remaining--
    try {
      const detail = await requestLotteForm(tab, form, 'detail', signal)
      const fields = detailResponseFields(detail)
      if (!fields) {
        flags.set(index, 'detail_response_schema_unverified')
        for (const issue of lotteResponseShapeIssues(detail)) diagnostics.add(issue)
        continue
      }
      const approved = fields.get('이용일시') && date(fields.get('이용일시')!)
      const expected = payloadDate(form.aprDtti)
      if (
        !approved ||
        !expected ||
        approved.slice(0, 10) !== expected.slice(0, 10) ||
        (expected.includes('T') && approved !== expected) ||
        fields.get('승인번호') !== form.aprno
      ) {
        flags.set(index, 'detail_identity_conflict')
        continue
      }
      overrides.set(index, fields)
      const identity = cardIdentities.get(form.encCdno)
      if (identity) cardOverrides.set(index, identity)
      else if (!row.cardLast4) {
        diagnostics.add('card_reference_not_in_selector')
        for (const issue of lotteCardIdentityDiagnostics(detail)) diagnostics.add(issue)
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''
      interruption = signal?.aborted
        ? 'cancelled'
        : reason === 'lotte_authentication_required'
          ? 'authentication_required'
          : reason === 'lotte_navigation_changed'
            ? 'navigation_changed'
            : reason === 'lotte_request_timeout'
              ? 'request_timeout'
              : 'detail_collection_unavailable'
      flags.set(index, 'detail_collection_unavailable')
      break
    }
  }
  const page = parseLotteApiResponse(response, overrides, flags, cardOverrides)
  return {
    page,
    diagnostics: [...diagnostics],
    ...(interruption ? { interruption } : {})
  }
}

/** Official form/radio semantics only; values stay in private main-process memory. No DOM writes. */
function requestPlanScript(from: string, to: string): string {
  return `(() => {
    const url = new URL(location.href);
    if (url.origin + url.pathname !== '${HISTORY}' || url.username || url.password) return { ok: false };
    const forms = [...document.querySelectorAll('form[name="LPMCDAAAprUseList"]')];
    if (forms.length !== 1) return { ok: false };
    const form = forms[0];
    const names = ${JSON.stringify(REQUEST_FIELDS)};
    const original = {};
    for (const name of names) {
      const fields = [...form.querySelectorAll('input,select')].filter(field => field.name === name);
      if (fields.length !== 1 || typeof fields[0].value !== 'string' || fields[0].value.length > (name === 'nextKey' ? 8192 : name === 'encCdno' ? 2048 : 128)) return { ok: false };
      original[name] = fields[0].value;
    }
    const all = document.querySelectorAll('input[type="checkbox"]#useCarditemAll');
    if (all.length !== 1) return { ok: false };
    const filters = {};
    for (const name of ['useCdDv','uplDv','useDv','stDv']) {
      const options = [...document.querySelectorAll('input[type="radio"]')].filter(field => field.name === name + 'Radio');
      const matched = options.filter(field => [...(field.labels || [])].some(label => label.textContent.replace(/\\s+/g, '').trim() === '전체'));
      if (matched.length !== 1 || !/^[a-zA-Z0-9_-]{0,16}$/.test(matched[0].value)) return { ok: false };
      filters[name] = matched[0].value;
    }
    if (!/^[1-9][0-9]{0,3}$/.test(original.pageRows) || Number(original.pageRows) > 1000) return { ok: false };
    let mildolYn = null;
    const detailForms = document.querySelectorAll('form[name="LPMCDAAArsUseDetail"]');
    if (detailForms.length === 1) {
      const fields = [...detailForms[0].querySelectorAll('input')].filter(field => field.name === 'mildolYn');
      if (fields.length === 1 && fields[0].value.length <= 128) mildolYn = fields[0].value;
    }
    const data = { ...original, ...filters, encCdno: '', startDt: ${JSON.stringify(from.replaceAll('-', ''))}, endDt: ${JSON.stringify(to.replaceAll('-', ''))}, pageNo: '1', nextKey: '', sortDv: '0' };
    const cards = [];
    const choices = [...document.querySelectorAll('input[name="useCarditem"]')];
    if (choices.length > 100) return { ok: false };
    for (const input of choices) {
      const item = input.closest('li');
      const idx = input.getAttribute('data-idx');
      if (!item || !idx || idx.length > 128) continue;
      const images = [...item.querySelectorAll('img[data-enccdno][data-idx]')].filter(image => image.getAttribute('data-idx') === idx);
      const labels = [...(input.labels || [])];
      if (images.length !== 1 || labels.length !== 1 || !item.contains(labels[0])) continue;
      const reference = images[0].getAttribute('data-enccdno');
      const matches = [...(labels[0].textContent || '').matchAll(/\\(([\\d*]{4,5})\\)/g)];
      if (!reference || reference.length > 2048 || matches.length !== 1 || !/\\d/.test(matches[0][1].slice(-4))) continue;
      cards.push({reference, tail: matches[0][1].slice(-4)});
    }
    return { ok: true, data, mildolYn, cards, scope: JSON.stringify({original, filters, mildolYn, cards}) };
  })()`
}

function integer(value: unknown, max: number): number | null {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value)))
    return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed <= max ? parsed : null
}

export const collectLotteApi: CardApiCollector = async (tab, range, options = {}) => {
  const started = Date.now()
  const rows: CardApiRow[] = []
  const issues = new Set<string>(['cancellation_query_basis_unverified'])
  let pages = 0
  let approvalComplete = false
  const result = (more: string[] = []): CardApiResult => ({
    rows,
    receipt: {
      issuer: 'lotte_card',
      range,
      pages,
      rowCount: rows.length,
      complete: false,
      approvalComplete,
      cancellationComplete: false,
      statusComplete: approvalComplete && rows.every((row) => row.needsReview.length === 0),
      issues: [...new Set([...issues, ...more])],
      elapsedMs: Date.now() - started
    }
  })
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(range.from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(range.to) ||
    !date(range.from) ||
    !date(range.to) ||
    range.from > range.to ||
    Date.parse(range.to) - Date.parse(range.from) > 3 * 86400000
  )
    return result(['invalid_range'])
  if (options.signal?.aborted) return result(['cancelled'])
  try {
    const wc = tab.view.webContents
    if (!wc || wc.isDestroyed() || !historyUrl(wc.getURL()))
      return result(['history_page_required'])
    const initial = wc.getURL()
    const auth = await bounded(pageBridge.cardSession(tab), options.signal)
    if (options.signal?.aborted) return result(['cancelled'])
    if (wc.isDestroyed() || wc.getURL() !== initial) return result(['navigation_changed'])
    if (auth.issuer !== 'lotte_card' || auth.state !== 'signed_in')
      return result(['authentication_required'])
    const maxPages = Math.min(100, options.maxPages ?? 100)
    if (!Number.isInteger(maxPages) || maxPages < 1) return result(['invalid_page_limit'])
    const planScript = requestPlanScript(range.from, range.to)
    const plan = await bounded(wc.executeJavaScript(planScript, false), options.signal)
    if (own(plan, 'ok') !== true || typeof own(plan, 'scope') !== 'string')
      return result(['request_schema_unverified'])
    const scope = own(plan, 'scope') as string
    if (scope.length > 16000) return result(['request_schema_unverified'])
    const form = own(plan, 'data') as LotteApiForm
    const cardIdentities = new Map<string, CardIdentity>()
    const conflictingReferences = new Set<string>()
    const cards = own(plan, 'cards')
    if (Array.isArray(cards)) {
      for (const card of cards) {
        const reference = own(card, 'reference')
        const tail = own(card, 'tail')
        if (
          typeof reference !== 'string' ||
          !reference ||
          reference.length > 2048 ||
          typeof tail !== 'string' ||
          !/^[\d*]{4}$/.test(tail) ||
          !/\d/.test(tail)
        )
          continue
        if (cardIdentities.has(reference)) conflictingReferences.add(reference)
        cardIdentities.set(reference, {
          cardKey: createHash('sha256')
            .update(JSON.stringify(['lotte_card', 'cdno', reference]))
            .digest('hex'),
          cardLast4: tail
        })
      }
      for (const reference of conflictingReferences) cardIdentities.delete(reference)
    }
    let expectedPage = 1
    let total: number | null = null
    let valid = true
    const detailBudget = { remaining: 1000 }
    const seen = new Map<string, CardApiRow>()
    for (;;) {
      if (options.signal?.aborted) return result(['cancelled'])
      if (wc.isDestroyed() || wc.getURL() !== initial) return result(['navigation_changed'])
      if (pages >= maxPages) return result(['page_limit'])
      const current = await bounded(wc.executeJavaScript(planScript, false), options.signal)
      if (own(current, 'ok') !== true || own(current, 'scope') !== scope)
        return result(['query_scope_changed'])
      const request = { ...form, pageNo: String(expectedPage), nextKey: '' }
      pages++
      const response = await requestLotteApiPage(tab, request, options.signal)
      const after = await bounded(wc.executeJavaScript(planScript, false), options.signal)
      if (own(after, 'ok') !== true || own(after, 'scope') !== scope)
        return result(['query_scope_changed'])
      if (wc.isDestroyed() || wc.getURL() !== initial) return result(['navigation_changed'])
      const param = own(response, 'Param')
      const currentPage = integer(own(param, 'pageNo'), 10000)
      const totalPages = integer(own(param, 'totalPage'), 10000)
      if (
        currentPage !== expectedPage ||
        totalPages === null ||
        (totalPages !== 0 && currentPage > totalPages)
      )
        return result(['pagination_unverified'])
      if (total !== null && total !== totalPages) return result(['pagination_changed'])
      total = totalPages
      for (const name of [
        'startDt',
        'endDt',
        'encCdno',
        'useDv',
        'useCdDv',
        'stDv',
        'uplDv',
        'pageRows'
      ] as const) {
        const echo = own(param, name)
        if (echo !== undefined && String(echo) !== request[name])
          return result(['response_scope_mismatch'])
      }
      let page = parseLotteApiResponse(response)
      if (page.rowCount === null) {
        for (const issue of lotteResponseShapeIssues(response)) issues.add(issue)
      }
      if (page.rowCount === null)
        return result([
          ...(totalPages === 0 ? ['empty_response_schema_unverified'] : []),
          ...page.issues
        ])
      if (
        (totalPages === 0 && page.rowCount !== 0) ||
        (totalPages > 0 &&
          page.rowCount === 0 &&
          !(
            summarizeLotteHistoryContent(response).root === 'empty' &&
            currentPage === 1 &&
            totalPages === 1 &&
            integer(own(param, 'nextPageNo'), 10000) === 1
          )) ||
        page.rowCount > Number(request.pageRows)
      )
        return result(['page_count_mismatch'])
      const enriched = await enrichLottePage(
        tab,
        response,
        own(plan, 'mildolYn'),
        cardIdentities,
        detailBudget,
        options.signal
      )
      page = enriched.page
      if (page.rows.some((row) => row.needsReview.length))
        for (const issue of lotteResponseShapeIssues(response)) issues.add(issue)
      if (page.rows.some((row) => row.needsReview.includes('identity_unverified'))) {
        issues.add(`card_selector_known_${cardIdentities.size}`)
        issues.add(
          `card_identified_rows_${page.rows.filter((row) => row.cardLast4 && row.approvalNumber).length}`
        )
      }
      for (const issue of enriched.diagnostics) issues.add(issue)
      if (page.rowCount === null) return result(['response_schema_unverified'])
      let interruption = enriched.interruption
      if (!interruption) {
        try {
          const afterDetails = await bounded(
            wc.executeJavaScript(planScript, false),
            options.signal
          )
          if (own(afterDetails, 'ok') !== true || own(afterDetails, 'scope') !== scope)
            interruption = 'query_scope_changed'
          if (wc.isDestroyed() || wc.getURL() !== initial) interruption = 'navigation_changed'
        } catch (error) {
          interruption = options.signal?.aborted
            ? 'cancelled'
            : error instanceof Error && error.message === 'lotte_request_timeout'
              ? 'request_timeout'
              : 'query_scope_unavailable'
        }
      }
      for (const issue of page.issues) issues.add(issue)
      if (page.rowCount !== page.rows.length || page.issues.length) valid = false
      for (const row of page.rows) {
        if (!(
          (row.approvedAt.slice(0, 10) >= range.from && row.approvedAt.slice(0, 10) <= range.to) ||
          (row.eventDate && row.eventDate >= range.from && row.eventDate <= range.to)
        )) {
          valid = false
          row.needsReview.push('outside_requested_range')
        }
        // The history range is an original-approval range. An explicitly labelled
        // refund can be applied to its unique original even though this query
        // cannot certify all refunds whose cancellation date is in the range.
        const previous = seen.get(row.sourceId)
        if (previous) {
          valid = false
          previous.needsReview = [
            ...new Set([...previous.needsReview, 'duplicate_source_identity'])
          ]
          row.needsReview = [...new Set([...row.needsReview, 'duplicate_source_identity'])]
          issues.add('duplicate_source_identity')
        } else seen.set(row.sourceId, row)
        for (const issue of row.needsReview) issues.add(issue)
        rows.push(row)
      }
      if (interruption) return result([interruption])
      if (totalPages === 0 || currentPage === totalPages) {
        approvalComplete = valid
        return result()
      }
      const next = integer(own(param, 'nextPageNo'), 10000)
      if (next !== expectedPage + 1) return result(['pagination_not_advancing'])
      expectedPage = next
    }
  } catch (error) {
    const issue = error instanceof Error ? error.message : ''
    return result([
      options.signal?.aborted
        ? 'cancelled'
        : issue === 'lotte_authentication_required'
          ? 'authentication_required'
          : issue === 'lotte_navigation_changed'
            ? 'navigation_changed'
            : issue === 'lotte_request_timeout'
              ? 'request_timeout'
              : 'collection_unavailable'
    ])
  }
}
