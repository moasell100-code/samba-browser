import { createHash } from 'node:crypto'
import { parse, type HTMLElement, type Node } from 'node-html-parser'
import { pageBridge } from '../browser/page-bridge'
import type { Tab } from '../browser/tab-manager'
import type { CardApiCollector, CardApiResult, CardApiRow } from './card-api-types'
import { summarizeLotteHistoryContent } from './lotte-response-summary'

const HISTORY = 'https://www.lottecard.co.kr/app/LPMCDAA_V100.lc'
const QUERY = 'https://www.lottecard.co.kr/app/LPMCDAA_A102.lc'
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
const MAX_TEXT = 2000

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
  return Number.isSafeInteger(amount) && Math.abs(amount) <= 1_000_000_000_000 ? amount : null
}
function detailFields(row: HTMLElement): Map<string, string> | null {
  const boxes = elements(row).filter(
    (node) => node.tagName === 'DIV' && node.classList.contains('useList')
  )
  if (boxes.length !== 1) return null
  const lists = elements(boxes[0]).filter((node) => node.tagName === 'UL')
  if (lists.length !== 1) return null
  const pairs = elements(lists[0])
  if (pairs.length !== DETAIL_LABELS.length || pairs.some((node) => node.tagName !== 'LI'))
    return null
  const result = new Map<string, string>()
  for (const [index, pair] of pairs.entries()) {
    const label = pair.childNodes
      .filter((node) => node.nodeType === 3)
      .map((node) => node.text)
      .join('')
      .replace(/\s+/g, '')
      .trim()
    const values = elements(pair).filter((node) => node.tagName === 'SPAN')
    if (label !== DETAIL_LABELS[index] || values.length !== 1) return null
    const value = text(values[0])
    if (value === null) return null
    result.set(label, value)
  }
  return result
}
function rowFromHtml(row: HTMLElement): CardApiRow | null {
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
  if (!merchant || !headDate || !cardLabel || headAmount === null) return null
  const details = detailFields(row)
  const needsReview: string[] = []
  if (!details) needsReview.push('details_unverified')
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
  const cardLast4 = cardMatch?.[1]
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
      ? ['lotte_card', cardLast4, approvedAt.slice(0, 10), approvalNumber]
      : ['lotte_card', 'unverified', cardLabel, approvedAt, merchant, amount]
  return {
    issuer: 'lotte_card',
    sourceId: `lotte:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`,
    kind: status === 'approved' ? 'approval' : 'status',
    approvedAt,
    ...(cancellationDate ? { eventDate: cancellationDate.slice(0, 10) } : {}),
    ...(approvalNumber ? { approvalNumber } : {}),
    ...(cardLast4 ? { cardLast4 } : {}),
    cardLabel,
    merchant,
    amount,
    currency: 'KRW',
    status,
    cancellationAmount,
    netAmount,
    needsReview
  }
}

/** Private normalized rows only. The caller must return receipt metadata, never this payload, to MCP. */
export function parseLotteApiResponse(parsed: unknown): LotteApiPage {
  const status = own(own(parsed, 'Status'), 'code')
  if (status !== 0 && status !== '0')
    return { rows: [], issues: ['response_status_unverified'], rowCount: null }
  const summary = summarizeLotteHistoryContent(parsed)
  if (summary.root === 'unrecognized')
    return { rows: [], issues: ['response_schema_unverified'], rowCount: null }
  const content = own(parsed, 'Content') as string
  const doc = parse(content)
  const root = summary.root === 'full' ? doc.querySelector('#useCardList')! : doc
  const rows: CardApiRow[] = []
  const issues = new Set<string>()
  for (const element of elements(root)) {
    const row = rowFromHtml(element)
    if (!row) {
      issues.add('unrecognized_rows')
      continue
    }
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
  if (signal?.aborted) throw new Error('lotte_request_cancelled')
  const keys = Object.keys(form)
  if (
    keys.length !== REQUEST_FIELDS.length ||
    keys.some((key) => !(REQUEST_FIELDS as readonly string[]).includes(key))
  )
    throw new Error('lotte_request_invalid')
  const body = new URLSearchParams()
  for (const name of REQUEST_FIELDS) {
    const value = own(form, name)
    const limit = name === 'nextKey' ? 8192 : name === 'encCdno' ? 2048 : 128
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
    if (signal?.aborted || wc.isDestroyed() || wc.getURL() !== initialUrl)
      throw new Error('lotte_request_cancelled')
  }
  const auth = await pageBridge.cardSession(tab)
  assertContext()
  if (auth.issuer !== 'lotte_card' || auth.state !== 'signed_in')
    throw new Error('lotte_authentication_required')
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), 20_000)
  timer.unref?.()
  let response: Response | undefined
  try {
    response = await wc.session.fetch(QUERY, {
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
    })
    assertContext()
    if (!response.ok || (response.url && response.url !== QUERY) || !response.body)
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
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > MAX_RESPONSE_BYTES) throw new Error('lotte_response_limit')
        chunks.push(Buffer.from(chunk.value))
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
    assertContext()
    const finalAuth = await pageBridge.cardSession(tab)
    assertContext()
    if (finalAuth.issuer !== 'lotte_card' || finalAuth.state !== 'signed_in')
      throw new Error('lotte_authentication_required')
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new Error('lotte_request_unavailable')
  } finally {
    clearTimeout(timer)
    await response?.body?.cancel().catch(() => undefined)
  }
}

// A102 page/next-key/filter semantics are intentionally not guessed. The authenticated
// query contract will supply the fixed request plan before this can claim completeness.
export const collectLotteApi: CardApiCollector = async (tab, range, options = {}) => {
  const started = Date.now()
  const result = (issues: string[]): CardApiResult => ({
    rows: [],
    receipt: {
      issuer: 'lotte_card',
      range,
      pages: 0,
      rowCount: 0,
      complete: false,
      issues,
      elapsedMs: Date.now() - started
    }
  })
  if (!date(range.from) || !date(range.to) || range.from > range.to)
    return result(['invalid_range'])
  if (options.signal?.aborted) return result(['cancelled'])
  try {
    const wc = tab.view.webContents
    if (!wc || wc.isDestroyed() || !historyUrl(wc.getURL()))
      return result(['history_page_required'])
    const initial = wc.getURL()
    const auth = await pageBridge.cardSession(tab)
    if (options.signal?.aborted) return result(['cancelled'])
    if (wc.isDestroyed() || wc.getURL() !== initial) return result(['navigation_changed'])
    if (auth.issuer !== 'lotte_card' || auth.state !== 'signed_in')
      return result(['authentication_required'])
    return result([
      'request_schema_unverified',
      'pagination_unverified',
      'cancellation_query_basis_unverified'
    ])
  } catch {
    return result(['collection_unavailable'])
  }
}
