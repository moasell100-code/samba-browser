import { parse, type HTMLElement, type Node } from 'node-html-parser'
import { z } from 'zod'
import type { Tab } from '../browser/tab-manager'
import { pageBridge } from '../browser/page-bridge'
import type { CardApiRow, CardDateRange } from './card-api-types'
import { dailyCardRanges, isCardDate, recentCardDateRange } from './card-date-range'
import {
  parseLotteApiResponse,
  requestLotteApiPage,
  type LotteApiForm
} from './lotte-api-collector'
import { summarizeLotteHistoryContent } from './lotte-response-summary'

const HISTORY = 'https://www.lottecard.co.kr/app/LPMCDAA_V100.lc'
const DETAIL = 'https://www.lottecard.co.kr/app/LPMCDAA_P103.lc'
const PUBLIC_ENUM = /^(?:[0-9]{1,2}|[A-Z])$/
const FIELDS = [
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
const LABELS = [
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
const FAILURES = [
  'invalid_range',
  'filter_unverified',
  'history_required',
  'session_unverified',
  'navigation_changed',
  'cancelled',
  'timeout',
  'scope_changed',
  'request_unavailable',
  'response_unverified',
  'response_scope_mismatch',
  'pagination_unverified',
  'page_limit',
  'duplicate_rows',
  'detail_limit',
  'detail_unavailable',
  'detail_unverified',
  'cancellation_date_unverified'
] as const
type Failure = (typeof FAILURES)[number]
type ScopeName = 'all' | 'cancellation'

export interface LotteCancelDateScope {
  paginationComplete: boolean
  pages: number
  rows: number
  fullRows: number
  partialRows: number
  otherRows: number
  approvalDateInside: number
  approvalDateOutside: number
  cancellationDateInside: number
  cancellationDateOutside: number
  cancellationDateUnknown: number
  datePairs: {
    bothInside: number
    approvalOnlyInside: number
    cancellationOnlyInside: number
    bothOutside: number
  }
  failureCounts: Record<Failure, number>
}
export interface LotteCancelDateDiagnostic {
  issuer: 'lotte_card'
  range: CardDateRange
  filterVerified: boolean
  all: LotteCancelDateScope
  cancellation: LotteCancelDateScope
}
export interface LotteCancelDateOptions {
  signal?: AbortSignal
  maxPages?: number
  /** Main-only, independently verified official label/value constants. Never an MCP argument. */
  filterContract?: Readonly<{ all: string; cancellation: string }>
}

class Stopped extends Error {
  constructor(readonly reason: Failure) {
    super(reason)
  }
}
function own(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined
}
function elements(node: Node): HTMLElement[] {
  return node.childNodes.filter((child): child is HTMLElement => child.nodeType === 1)
}
function moment(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const compact = /^\d{8}(?:\d{6}(?:\d{3})?)?$/.test(value)
  const normalized = compact
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}${value.length >= 14 ? ` ${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}` : ''}`
    : value.trim()
  const match =
    /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})\.?\s*(?:[T ]?(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\+09:00)?)?$/.exec(
      normalized
    )
  if (!match) return null
  const result = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
  if (!isCardDate(result)) return null
  if (match[4] === undefined) return result
  if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] ?? 0) > 59) return null
  return `${result}T${match[4].padStart(2, '0')}:${match[5]}:${match[6] ?? '00'}+09:00`
}
function day(value: unknown): string | null {
  return moment(value)?.slice(0, 10) ?? null
}
function integer(value: unknown): number | null {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value)))
    return null
  const result = Number(value)
  return Number.isSafeInteger(result) && result <= 10000 ? result : null
}
function emptyScope(): LotteCancelDateScope {
  return {
    paginationComplete: false,
    pages: 0,
    rows: 0,
    fullRows: 0,
    partialRows: 0,
    otherRows: 0,
    approvalDateInside: 0,
    approvalDateOutside: 0,
    cancellationDateInside: 0,
    cancellationDateOutside: 0,
    cancellationDateUnknown: 0,
    datePairs: { bothInside: 0, approvalOnlyInside: 0, cancellationOnlyInside: 0, bothOutside: 0 },
    failureCounts: Object.fromEntries(FAILURES.map((name) => [name, 0])) as Record<Failure, number>
  }
}
async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Stopped('cancelled')
  return new Promise((resolve, reject) => {
    const stop = (): void => {
      signal.removeEventListener('abort', stop)
      reject(new Stopped('cancelled'))
    }
    signal.addEventListener('abort', stop, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', stop)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop)
        if (error instanceof Stopped) reject(error)
        else {
          const safe = new Map<string, Failure>([
            ['lotte_authentication_required', 'session_unverified'],
            ['lotte_navigation_changed', 'navigation_changed'],
            ['lotte_request_cancelled', 'cancelled'],
            ['lotte_request_timeout', 'timeout']
          ])
          reject(
            new Stopped(
              error instanceof Error
                ? (safe.get(error.message) ?? 'request_unavailable')
                : 'request_unavailable'
            )
          )
        }
      }
    )
  })
}
function planScript(range: CardDateRange): string {
  return `(() => {
    const url = new URL(location.href);
    if (url.origin + url.pathname !== ${JSON.stringify(HISTORY)} || url.username || url.password) return {ok:false};
    const forms = document.querySelectorAll('form[name="LPMCDAAAprUseList"]');
    if (forms.length !== 1) return {ok:false};
    const original = {};
    for (const name of ${JSON.stringify(FIELDS)}) {
      const fields = [...forms[0].querySelectorAll('input,select')].filter(field => field.name === name);
      if (fields.length !== 1 || typeof fields[0].value !== 'string' || fields[0].value.length > (name === 'nextKey' ? 8192 : name === 'encCdno' ? 2048 : 128)) return {ok:false};
      original[name] = fields[0].value;
    }
    if (document.querySelectorAll('input[type="checkbox"]#useCarditemAll').length !== 1) return {ok:false};
    const filters = {};
    const labelValue = (name,label) => {
      const found = [...document.querySelectorAll('input[type="radio"]')].filter(field => field.name === name + 'Radio' && [...(field.labels || [])].some(item => item.textContent.replace(/\\s+/g,'').trim() === label));
      if (found.length !== 1) return null;
      const value = found[0].getAttribute('value');
      return value !== null && (name === 'stDv' ? /^(?:[0-9]{1,2}|[A-Z])$/ : /^[a-zA-Z0-9_-]{0,16}$/).test(value) ? value : null;
    };
    for (const name of ['useCdDv','uplDv','useDv','stDv']) { filters[name] = labelValue(name,'전체'); if (filters[name] === null) return {ok:false}; }
    const cancellation = labelValue('stDv','취소');
    if (cancellation === null || cancellation === filters.stDv || !/^[1-9][0-9]{0,3}$/.test(original.pageRows) || Number(original.pageRows) > 1000) return {ok:false};
    const detail = document.querySelectorAll('form[name="LPMCDAAArsUseDetail"]');
    const mildol = detail.length === 1 ? [...detail[0].querySelectorAll('input')].filter(field => field.name === 'mildolYn') : [];
    const mildolYn = mildol.length === 1 && mildol[0].value.length <= 128 ? mildol[0].value : null;
    const data = {...original,...filters,encCdno:'',startDt:${JSON.stringify(range.from.replaceAll('-', ''))},endDt:${JSON.stringify(range.to.replaceAll('-', ''))},pageNo:'1',nextKey:'',sortDv:'0'};
    return {ok:true,data,cancellation,mildolYn,scope:JSON.stringify({original,filters,cancellation,mildolYn})};
  })()`
}
function readableText(node: Node): string | null {
  let value = ''
  let visited = 0
  const visit = (current: Node): void => {
    if (++visited > 200 || value.length > 2048) throw new Error()
    if (current.nodeType === 3) value += current.text
    else if (current.nodeType === 1) {
      const element = current as HTMLElement
      if (
        [
          'INPUT',
          'TEXTAREA',
          'SELECT',
          'BUTTON',
          'SCRIPT',
          'STYLE',
          'TEMPLATE',
          'NOSCRIPT'
        ].includes(element.tagName) ||
        element.hasAttribute('contenteditable')
      )
        return
      for (const child of element.childNodes) visit(child)
    }
  }
  try {
    visit(node)
    return value.length <= 2048 ? value.replace(/\s+/g, ' ').trim() : null
  } catch {
    return null
  }
}
function detailForm(
  element: HTMLElement,
  row: CardApiRow,
  mildolYn: unknown
): Record<string, string> | null {
  if (typeof mildolYn !== 'string' || mildolYn.length > 128) return null
  const buttons = element.querySelectorAll('[data-object]')
  if (buttons.length !== 1 || buttons[0].tagName !== 'BUTTON' || buttons[0].parentNode !== element)
    return null
  const siblings = elements(element)
  const next = siblings[siblings.indexOf(buttons[0]) + 1]
  if (!next || next.tagName !== 'DIV' || !next.classList.contains('useList')) return null
  const data = buttons[0].getAttribute('data-object') ?? ''
  if (data.length > 16000) return null
  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    return null
  }
  const form: Record<string, string> = {}
  for (const name of DETAIL_FIELDS) {
    const value =
      name === 'lono' || name === 'type'
        ? ''
        : name === 'mildolYn'
          ? mildolYn
          : own(payload, name === 'encCdno' ? 'cdno' : name)
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value)))
      return null
    form[name] = String(value)
    if (
      form[name].length > (name === 'encCdno' ? 2048 : name === 'mcNm' ? 512 : 128) ||
      [...form[name]].some((character) => character.charCodeAt(0) < 32)
    )
      return null
  }
  if (
    !form.encCdno ||
    !/^[A-Za-z0-9-]{1,80}$/.test(form.aprno) ||
    /^-+$/.test(form.aprno) ||
    !/^(?:[0-9]|1[0-9])$/.test(form.aprTrc) ||
    day(form.aprDtti) !== day(row.approvedAt) ||
    form.mcNm.replace(/\s+/g, ' ').trim() !== row.merchant.replace(/\s+/g, ' ').trim()
  )
    return null
  return form
}
function detailDate(response: unknown, form: Record<string, string>): string | null {
  if (![0, '0'].includes(own(own(response, 'Status'), 'code') as number)) return null
  const content = own(response, 'Content')
  if (typeof content !== 'string' || Buffer.byteLength(content) > 2 * 1024 * 1024) return null
  const doc = parse(content)
  const roots = elements(doc)
  const lists = doc.querySelectorAll('ul')
  if (
    roots.length < 1 ||
    roots.length > 2 ||
    roots.some((root) => !['UL', 'DIV'].includes(root.tagName)) ||
    lists.length !== 1 ||
    !roots.includes(lists[0]) ||
    doc.childNodes.some((node) => node.nodeType === 3 && node.text.trim())
  )
    return null
  const pairs = elements(lists[0])
  const values = new Map<string, string>()
  let index = 0
  if (pairs.length < LABELS.length || pairs.length > LABELS.length + 2) return null
  for (const pair of pairs) {
    if (pair.tagName !== 'LI') return null
    const label = pair.childNodes
      .filter((node) => node.nodeType === 3)
      .map((node) => node.text)
      .join('')
      .replace(/\s+/g, '')
    const spans = elements(pair).filter((node) => node.tagName === 'SPAN')
    if (spans.length !== 1 || values.has(label)) return null
    if (label !== '업종' && label !== '분야' && label !== LABELS[index++]) return null
    const value = readableText(spans[0])
    if (value === null) return null
    values.set(label, value)
  }
  const expected = moment(form.aprDtti)
  const approved = moment(values.get('이용일시'))
  if (
    index !== LABELS.length ||
    values.get('승인번호') !== form.aprno ||
    !expected ||
    !approved ||
    day(approved) !== day(expected) ||
    (expected.includes('T') && expected !== approved) ||
    !['취소', '취소완료', '부분취소'].includes(values.get('취소여부') ?? '')
  )
    return null
  return day(values.get('취소일자'))
}

/** No writes or navigations. The result contains counts/enums only; raw fields stay in main. */
export async function probeLotteCancellationDateBasis(
  tab: Tab,
  range: CardDateRange,
  options: LotteCancelDateOptions = {}
): Promise<LotteCancelDateDiagnostic> {
  const result: LotteCancelDateDiagnostic = {
    issuer: 'lotte_card',
    range: { from: '', to: '' },
    filterVerified: false,
    all: emptyScope(),
    cancellation: emptyScope()
  }
  const failBoth = (reason: Failure): LotteCancelDateDiagnostic => {
    result.all.failureCounts[reason]++
    result.cancellation.failureCounts[reason]++
    return result
  }
  try {
    dailyCardRanges(range)
  } catch {
    return failBoth('invalid_range')
  }
  if (range.from < '2026-07-01' || range.to > recentCardDateRange().to)
    return failBoth('invalid_range')
  result.range = { ...range }
  const contract = options.filterContract
  // The caller may supply only independently verified static constants, never guessed codes.
  if (
    !contract ||
    ![contract.all, contract.cancellation].every(
      (value) => typeof value === 'string' && PUBLIC_ENUM.test(value)
    ) ||
    contract.all === contract.cancellation
  )
    return failBoth('filter_unverified')
  const allowed = z.enum([contract.all, contract.cancellation])
  const maxPages = options.maxPages ?? 100
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) return failBoth('page_limit')
  const wc = tab.view.webContents
  const profile = tab.profile
  const initial = wc.getURL()
  try {
    const url = new URL(initial)
    if (url.username || url.password || url.origin + url.pathname !== HISTORY || wc.isDestroyed())
      return failBoth('history_required')
  } catch {
    return failBoth('history_required')
  }
  const controller = new AbortController()
  let timedOut = false
  let changed = false
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal
  const stop = (): void => {
    changed = true
    controller.abort()
  }
  const navigate = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean): void => {
    if (mainFrame) stop()
  }
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, 90_000)
  wc.on('did-start-navigation', navigate)
  wc.on('destroyed', stop)
  const script = planScript(range)
  let currentScope: ScopeName | undefined
  const assertContext = (): void => {
    if (timedOut) throw new Stopped('timeout')
    if (
      changed ||
      tab.view.webContents !== wc ||
      tab.profile !== profile ||
      wc.isDestroyed() ||
      wc.getURL() !== initial
    )
      throw new Stopped('navigation_changed')
    if (signal.aborted) throw new Stopped('cancelled')
  }
  const auth = async (): Promise<void> => {
    assertContext()
    const session = await bounded(pageBridge.cardSession(tab), signal)
    assertContext()
    if (session.issuer !== 'lotte_card' || session.state !== 'signed_in')
      throw new Stopped('session_unverified')
  }
  try {
    await auth()
    const plan = await bounded(wc.executeJavaScript(script, false), signal)
    assertContext()
    const form = own(plan, 'data') as LotteApiForm
    const cancellation = own(plan, 'cancellation')
    const scope = own(plan, 'scope')
    if (
      own(plan, 'ok') !== true ||
      typeof scope !== 'string' ||
      scope.length > 20000 ||
      !form ||
      !allowed.safeParse(form.stDv).success ||
      !allowed.safeParse(cancellation).success ||
      form.stDv !== contract.all ||
      cancellation !== contract.cancellation
    )
      throw new Stopped('filter_unverified')
    result.filterVerified = true
    const checkScope = async (): Promise<void> => {
      await auth()
      const current = await bounded(wc.executeJavaScript(script, false), signal)
      assertContext()
      if (own(current, 'ok') !== true || own(current, 'scope') !== scope)
        throw new Stopped('scope_changed')
    }
    for (const name of ['all', 'cancellation'] as const) {
      currentScope = name
      const stats = result[name]
      const seen = new Set<string>()
      let total: number | undefined
      let details = 0
      try {
        for (let pageNo = 1; ; pageNo++) {
          if (pageNo > maxPages) throw new Stopped('page_limit')
          await checkScope()
          const request = {
            ...form,
            stDv: name === 'all' ? contract.all : contract.cancellation,
            pageNo: String(pageNo),
            nextKey: ''
          }
          stats.pages++
          const response = await bounded(requestLotteApiPage(tab, request, signal), signal)
          await checkScope()
          const param = own(response, 'Param')
          const page = parseLotteApiResponse(response)
          const returnedPage = integer(own(param, 'pageNo'))
          const totalPage = integer(own(param, 'totalPage'))
          if (
            returnedPage !== pageNo ||
            totalPage === null ||
            (totalPage !== 0 && pageNo > totalPage) ||
            (total !== undefined && total !== totalPage)
          )
            throw new Stopped('pagination_unverified')
          total = totalPage
          for (const field of [
            'startDt',
            'endDt',
            'encCdno',
            'useDv',
            'useCdDv',
            'stDv',
            'uplDv',
            'pageRows',
            'schDv'
          ] as const) {
            const echo = own(param, field)
            if (
              echo !== undefined &&
              ((typeof echo !== 'string' && typeof echo !== 'number') ||
                String(echo) !== request[field])
            )
              throw new Stopped('response_scope_mismatch')
          }
          if (
            page.rowCount === null ||
            page.rowCount !== page.rows.length ||
            page.issues.length ||
            page.rowCount > Number(request.pageRows) ||
            (totalPage === 0 && page.rowCount !== 0) ||
            (page.rowCount === 0 &&
              totalPage > 0 &&
              !(
                pageNo === 1 &&
                totalPage === 1 &&
                summarizeLotteHistoryContent(response).root === 'empty' &&
                integer(own(param, 'nextPageNo')) === 1
              ))
          )
            throw new Stopped('response_unverified')
          const doc = parse(own(response, 'Content') as string)
          const rows = elements(doc.querySelector('#useCardList') ?? doc)
          for (const [index, row] of page.rows.entries()) {
            if (seen.has(row.sourceId)) throw new Stopped('duplicate_rows')
            seen.add(row.sourceId)
            stats.rows++
            const approved = day(row.approvedAt)
            const approvalInside = !!approved && approved >= range.from && approved <= range.to
            stats[approvalInside ? 'approvalDateInside' : 'approvalDateOutside']++
            if (!['cancelled', 'partially_cancelled'].includes(row.status)) {
              stats.otherRows++
              continue
            }
            stats[row.status === 'cancelled' ? 'fullRows' : 'partialRows']++
            let cancelled =
              row.eventDate &&
              row.approvalNumber &&
              !row.needsReview.some((issue) =>
                [
                  'approval_date_conflict',
                  'cancellation_date_unverified',
                  'identity_unverified'
                ].includes(issue)
              )
                ? day(row.eventDate)
                : null
            if (!cancelled) {
              const detail = detailForm(rows[index], row, own(plan, 'mildolYn'))
              if (!detail) stats.failureCounts.detail_unavailable++
              else if (++details > 1000) stats.failureCounts.detail_limit++
              else {
                const timeout = new AbortController()
                const requestTimer = setTimeout(() => timeout.abort(), 20_000)
                const requestSignal = AbortSignal.any([signal, timeout.signal])
                let response: Response | undefined
                try {
                  await checkScope()
                  response = await bounded(
                    wc.session.fetch(DETAIL, {
                      method: 'POST',
                      credentials: 'include',
                      redirect: 'error',
                      headers: {
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'X-Requested-With': 'XMLHttpRequest',
                        Referer: HISTORY
                      },
                      body: new URLSearchParams(detail).toString(),
                      signal: requestSignal
                    }),
                    requestSignal
                  )
                  await checkScope()
                  if (!response.ok || (response.url && response.url !== DETAIL) || !response.body)
                    throw new Stopped('detail_unverified')
                  const length = response.headers.get('content-length')
                  if (length && (!/^\d+$/.test(length) || Number(length) > 2 * 1024 * 1024))
                    throw new Stopped('detail_unverified')
                  const reader = response.body.getReader()
                  let bytes = 0
                  const chunks: Uint8Array[] = []
                  try {
                    for (;;) {
                      const part = await bounded(reader.read(), requestSignal)
                      assertContext()
                      if (part.done) break
                      bytes += part.value.byteLength
                      if (bytes > 2 * 1024 * 1024) throw new Stopped('detail_unverified')
                      chunks.push(part.value)
                    }
                  } finally {
                    void reader.cancel().catch(() => undefined)
                  }
                  await checkScope()
                  cancelled = detailDate(JSON.parse(Buffer.concat(chunks).toString('utf8')), detail)
                  if (!cancelled) stats.failureCounts.detail_unverified++
                } catch (error) {
                  assertContext()
                  if (
                    !timeout.signal.aborted &&
                    error instanceof Stopped &&
                    [
                      'scope_changed',
                      'session_unverified',
                      'navigation_changed',
                      'cancelled',
                      'timeout'
                    ].includes(error.reason)
                  )
                    throw error
                  stats.failureCounts.detail_unverified++
                } finally {
                  clearTimeout(requestTimer)
                  timeout.abort()
                  void response?.body?.cancel().catch(() => undefined)
                }
              }
            }
            if (
              !cancelled ||
              !approved ||
              cancelled < approved ||
              cancelled > recentCardDateRange().to
            ) {
              stats.cancellationDateUnknown++
              stats.failureCounts.cancellation_date_unverified++
              continue
            }
            const cancellationInside = cancelled >= range.from && cancelled <= range.to
            stats[cancellationInside ? 'cancellationDateInside' : 'cancellationDateOutside']++
            stats.datePairs[
              approvalInside
                ? cancellationInside
                  ? 'bothInside'
                  : 'approvalOnlyInside'
                : cancellationInside
                  ? 'cancellationOnlyInside'
                  : 'bothOutside'
            ]++
          }
          if (totalPage === 0 || pageNo === totalPage) {
            stats.paginationComplete = true
            break
          }
          if (integer(own(param, 'nextPageNo')) !== pageNo + 1)
            throw new Stopped('pagination_unverified')
        }
      } catch (error) {
        assertContext()
        if (
          error instanceof Stopped &&
          [
            'session_unverified',
            'navigation_changed',
            'cancelled',
            'timeout',
            'scope_changed'
          ].includes(error.reason)
        )
          throw error
        stats.failureCounts[error instanceof Stopped ? error.reason : 'request_unavailable']++
      }
    }
    return result
  } catch (error) {
    const reason = timedOut
      ? 'timeout'
      : changed
        ? 'navigation_changed'
        : error instanceof Stopped
          ? error.reason
          : signal.aborted
            ? 'cancelled'
            : 'request_unavailable'
    if (currentScope) {
      result[currentScope].failureCounts[reason]++
      if (currentScope === 'all') result.cancellation.failureCounts[reason]++
    } else {
      result.all.failureCounts[reason]++
      result.cancellation.failureCounts[reason]++
    }
    return result
  } finally {
    clearTimeout(timer)
    controller.abort()
    wc.removeListener('did-start-navigation', navigate)
    wc.removeListener('destroyed', stop)
  }
}
