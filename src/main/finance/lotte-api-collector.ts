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
  if (
    !merchant ||
    merchant.length > 255 ||
    !headDate ||
    !cardLabel ||
    cardLabel.length > 120 ||
    headAmount === null
  )
    return null
  const details = detailFields(row)
  const needsReview: string[] = []
  if (!details) needsReview.push('details_unverified')
  if (!/[₩원]/.test(amounts[0] ?? '')) needsReview.push('currency_unverified')
  const method = metadata[2]
  if (method !== '일시불' && method !== '할부') needsReview.push('transaction_type_unverified')
  const detailMethod = details?.get('거래유형')
  if (detailMethod && detailMethod !== method) needsReview.push('transaction_type_conflict')
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
  const detailRefund = krw(details?.get('취소금액'))
  const cancellationLabel = details?.get('취소여부')
  if (
    details &&
    cancellationLabel !== '정상' &&
    !['취소', '취소완료', '부분취소'].includes(cancellationLabel ?? '')
  ) {
    needsReview.push('status_unverified')
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
      wc.session.fetch(QUERY, {
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
    const data = { ...original, ...filters, encCdno: '', startDt: ${JSON.stringify(from.replaceAll('-', ''))}, endDt: ${JSON.stringify(to.replaceAll('-', ''))}, pageNo: '1', nextKey: '', sortDv: '0' };
    return { ok: true, data, scope: JSON.stringify({original, filters}) };
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
    let expectedPage = 1
    let total: number | null = null
    let valid = true
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
      const page = parseLotteApiResponse(response)
      if (page.rowCount === null)
        return result([
          ...(totalPages === 0 ? ['empty_response_schema_unverified'] : []),
          ...page.issues
        ])
      for (const issue of page.issues) issues.add(issue)
      if (page.rowCount !== page.rows.length || page.issues.length) valid = false
      if (
        (totalPages === 0 && page.rowCount !== 0) ||
        (totalPages > 0 && page.rowCount === 0) ||
        page.rowCount > Number(request.pageRows)
      )
        return result(['page_count_mismatch'])
      for (const row of page.rows) {
        if (!(
          (row.approvedAt.slice(0, 10) >= range.from && row.approvedAt.slice(0, 10) <= range.to) ||
          (row.eventDate && row.eventDate >= range.from && row.eventDate <= range.to)
        )) {
          valid = false
          row.needsReview.push('outside_requested_range')
        }
        if (row.status !== 'approved')
          row.needsReview = [
            ...new Set([...row.needsReview, 'cancellation_query_basis_unverified'])
          ]
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
