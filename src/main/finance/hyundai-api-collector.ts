import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Tab } from '../browser/tab-manager'
import { pageBridge } from '../browser/page-bridge'
import type { CardApiCollector, CardApiResult, CardApiRow } from './card-api-types'

const HISTORY_PATH = '/cpa/cb/CPACB0101_01.hc'
const QUERY_PATH = '/cpa/cb/apiCPACB0101_21.hc'
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_ROWS = 1000
const ALL_CARD_LABELS = ['전체', '전체카드', '카드전체', '모든카드'] as const
const SAFE_ERRORS = new Set([
  'hyundai_request_cancelled',
  'hyundai_request_timeout',
  'hyundai_request_invalid',
  'hyundai_history_required',
  'hyundai_navigation_changed',
  'hyundai_authentication_required',
  'hyundai_response_unavailable',
  'hyundai_response_limit',
  'hyundai_request_unavailable'
])
const REQUEST_FIELDS = [
  'crno',
  'dmfrClsf',
  'dtClsf',
  'endDt',
  'listClsf',
  'sortType',
  'srtDt',
  'useClsf',
  'usplClsf',
  'zoneClsf'
] as const
export type HyundaiApiForm = Readonly<Record<(typeof REQUEST_FIELDS)[number], string>>

const scopeSchema = z
  .object({
    state: z.literal('ready'),
    formCount: z.number().int().min(0).max(1000),
    cardSelectCount: z.number().int().min(0).max(1000),
    cardDisabled: z.boolean().nullable(),
    optionCount: z.number().int().min(0).max(1000),
    options: z
      .array(
        z
          .object({
            label: z.enum([...ALL_CARD_LABELS, 'unrecognized']),
            optionLabel: z.enum([...ALL_CARD_LABELS, 'unrecognized']),
            textEmpty: z.boolean(),
            hasWholeWord: z.boolean(),
            disabled: z.boolean()
          })
          .strict()
      )
      .max(20),
    directPresent: z.boolean(),
    directLabels: z.array(z.enum(['직접입력', 'unrecognized'])).max(10),
    recentPresent: z.boolean(),
    allRadioCounts: z
      .object({
        useClsf: z.number().int().min(0).max(1000),
        usplClsf: z.number().int().min(0).max(1000),
        zoneClsf: z.number().int().min(0).max(1000)
      })
      .strict(),
    dateFormats: z
      .object({
        start: z.enum(['compact', 'iso', 'other', 'missing']),
        end: z.enum(['compact', 'iso', 'other', 'missing'])
      })
      .strict()
  })
  .strict()

export type HyundaiScopeInspection =
  | z.infer<typeof scopeSchema>
  | {
      state: 'unsupported' | 'authentication_required' | 'navigation_changed' | 'unavailable'
    }

const SCOPE_SCRIPT = `(() => {
  const url = new URL(location.href);
  if (url.username || url.password || !['https://www.hyundaicard.com','https://hyundaicard.com'].includes(url.origin) || url.pathname !== '${HISTORY_PATH}') return { state: 'unsupported' };
  const forms = document.querySelectorAll('form#form1');
  const form = forms.length === 1 ? forms[0] : null;
  const cards = form ? form.querySelectorAll('select[name="crno"]') : [];
  const labels = Array.from(document.querySelectorAll('label'));
  const text = element => (element && element.textContent || '').replace(/\\s+/g, '');
  const optionList = cards.length === 1 ? Array.from(cards[0].options) : [];
  const allLabels = ${JSON.stringify(ALL_CARD_LABELS)};
  const radioCount = name => form ? Array.from(form.querySelectorAll('input[type="radio"][name="' + name + '"]')).filter(input => !input.disabled && input.id && labels.some(label => label.htmlFor === input.id && text(label) === '전체')).length : 0;
  const format = id => {
    const input = form && form.querySelector('#' + id);
    if (!input || input.tagName !== 'INPUT' || ['password','file'].includes(input.type)) return 'missing';
    return /^\\d{8}$/.test(input.value) ? 'compact' : /^\\d{4}-\\d{2}-\\d{2}$/.test(input.value) ? 'iso' : 'other';
  };
  const direct = form && form.querySelector('input[type="radio"][name="dtClsf"]#dtClsf_04');
  const recent = form && form.querySelector('input[type="radio"][name="listClsf"]#listClsf_01');
  return {
    state: 'ready',
    formCount: Math.min(forms.length, 1000),
    cardSelectCount: Math.min(cards.length, 1000),
    cardDisabled: cards.length === 1 ? cards[0].disabled : null,
    optionCount: Math.min(optionList.length, 1000),
    options: optionList.slice(0, 20).map(option => {
      const optionLabel = (option.label || '').replace(/\\s+/g, '');
      return { label: allLabels.includes(text(option)) ? text(option) : 'unrecognized', optionLabel: allLabels.includes(optionLabel) ? optionLabel : 'unrecognized', textEmpty: text(option) === '', hasWholeWord: text(option).includes('전체') || optionLabel.includes('전체'), disabled: option.disabled };
    }),
    directPresent: !!direct && !direct.disabled,
    directLabels: direct ? labels.filter(label => label.htmlFor === direct.id).slice(0, 10).map(label => text(label) === '직접입력' ? '직접입력' : 'unrecognized') : [],
    recentPresent: !!recent && !recent.disabled,
    allRadioCounts: { useClsf: Math.min(radioCount('useClsf'), 1000), usplClsf: Math.min(radioCount('usplClsf'), 1000), zoneClsf: Math.min(radioCount('zoneClsf'), 1000) },
    dateFormats: { start: format('iqrySrtDt'), end: format('iqryEndDt') }
  };
})()`

/** Narrow diagnostic: public fixed label enums/counts only, never card names or form values. */
export async function inspectHyundaiScope(tab: Tab): Promise<HyundaiScopeInspection> {
  try {
    const wc = tab.view.webContents
    if (wc.isDestroyed() || !historyOrigin(wc.getURL())) return { state: 'unsupported' }
    const initialUrl = wc.getURL()
    const auth = await bounded(pageBridge.hyundaiAuth(tab))
    if (wc.isDestroyed() || wc.getURL() !== initialUrl) return { state: 'navigation_changed' }
    if (auth.state !== 'signed_in') return { state: 'authentication_required' }
    const raw: unknown = await bounded(wc.executeJavaScript(SCOPE_SCRIPT, false))
    if (wc.isDestroyed() || wc.getURL() !== initialUrl) return { state: 'navigation_changed' }
    const result = scopeSchema.safeParse(raw)
    if (!result.success) return { state: 'unavailable' }
    const after = await bounded(pageBridge.hyundaiAuth(tab))
    if (wc.isDestroyed() || wc.getURL() !== initialUrl) return { state: 'navigation_changed' }
    if (after.state !== 'signed_in') return { state: 'authentication_required' }
    return result.data
  } catch {
    return { state: 'unavailable' }
  }
}

function requestPlanScript(from: string, to: string): string {
  return `(() => {
    const url = new URL(location.href);
    const fail = issue => ({ ok: false, issue });
    if (url.username || url.password || !['https://www.hyundaicard.com','https://hyundaicard.com'].includes(url.origin) || url.pathname !== '${HISTORY_PATH}') return fail('history_page_required');
    const forms = document.querySelectorAll('form#form1');
    if (forms.length !== 1) return fail('request_schema_unverified');
    const form = forms[0];
    const text = element => (element && element.textContent || '').replace(/\\s+/g, '');
    const allRadio = name => {
      const matches = Array.from(form.querySelectorAll('input[type="radio"][name="' + name + '"]')).filter(input => {
        if (!input.id || input.disabled) return false;
        return Array.from(document.querySelectorAll('label')).some(label => label.htmlFor === input.id && text(label) === '전체');
      });
      return matches.length === 1 ? matches[0].value : null;
    };
    const fixedRadio = (id, name, expectedLabel) => {
      const input = form.querySelector('#' + id);
      if (!input || input.tagName !== 'INPUT' || input.type !== 'radio' || input.name !== name || input.disabled) return null;
      if (expectedLabel && !Array.from(document.querySelectorAll('label')).some(label => label.htmlFor === id && text(label) === expectedLabel)) return null;
      return input.value;
    };
    const scalar = name => {
      const inputs = form.querySelectorAll('[name="' + name + '"]');
      if (inputs.length !== 1) return null;
      const input = inputs[0];
      if (input.disabled || !['INPUT','SELECT'].includes(input.tagName) || ['password','file','radio','checkbox'].includes(input.type)) return null;
      return input.value;
    };
    const cards = form.querySelectorAll('select[name="crno"]');
    if (cards.length !== 1 || cards[0].disabled) return fail('card_selector_unverified');
    const allCardLabels = ${JSON.stringify(ALL_CARD_LABELS)};
    const allCards = Array.from(cards[0].options).filter(option => !option.disabled && allCardLabels.includes((option.label || '').replace(/\\s+/g, '')));
    if (allCards.length !== 1) return fail('card_selector_unverified');
    const direct = fixedRadio('dtClsf_04', 'dtClsf', '직접입력');
    const recent = fixedRadio('listClsf_01', 'listClsf', null);
    if (direct === null || recent === null) return fail('request_schema_unverified');
    const formatDate = (id, date) => {
      const input = form.querySelector('#' + id);
      if (!input || input.tagName !== 'INPUT' || ['password','file'].includes(input.type)) return null;
      if (/^\\d{8}$/.test(input.value)) return date.replace(/-/g, '');
      if (/^\\d{4}-\\d{2}-\\d{2}$/.test(input.value)) return date;
      return null;
    };
    const data = {
      crno: allCards[0].value,
      dmfrClsf: scalar('dmfrClsf'),
      dtClsf: direct,
      endDt: formatDate('iqryEndDt', ${JSON.stringify(to)}),
      listClsf: recent,
      sortType: scalar('sortType'),
      srtDt: formatDate('iqrySrtDt', ${JSON.stringify(from)}),
      useClsf: allRadio('useClsf'),
      usplClsf: allRadio('usplClsf'),
      zoneClsf: allRadio('zoneClsf')
    };
    for (const value of Object.values(data)) if (typeof value !== 'string' || value.length > 256 || /[\\u0000-\\u001f\\u007f]/.test(value)) return fail('request_schema_unverified');
    return { ok: true, data };
  })()`
}

export interface HyundaiApiPage {
  rows: CardApiRow[]
  issues: string[]
  rowCount: number | null
  reportedTotal: number | null
}

async function bounded<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('hyundai_request_timeout')), 20_000)
        timer.unref?.()
        abort = () => reject(new Error('hyundai_request_cancelled'))
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
  }
}

function own(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined
}

function scalar(value: unknown, maximum = 2000): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  const result = String(value).trim()
  return result.length <= maximum ? result : null
}

function date(value: unknown): string | null {
  const input = scalar(value, 40)
  if (!input) return null
  const match = /^(\d{4})[.-]?(\d{2})[.-]?(\d{2})$/.exec(input)
  if (!match) return null
  const iso = `${match[1]}-${match[2]}-${match[3]}`
  const parsed = new Date(`${iso}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null
}

function dateTime(value: unknown): string | null {
  const input = scalar(value, 40)
  if (!input) return null
  const match = /^(\d{4}[.-]?\d{2}[.-]?\d{2})(?:[ T]?(\d{2}):?(\d{2}):?(\d{2}))?$/.exec(input)
  if (!match) return null
  const day = date(match[1])
  if (!day) return null
  if (!match[2]) return day
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return null
  return `${day}T${match[2]}:${match[3]}:${match[4]}+09:00`
}

function won(value: unknown): number | null {
  const input = scalar(value, 40)
  if (!input || !/^-?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(input)) return null
  const amount = Number(input.replaceAll(',', ''))
  return Number.isSafeInteger(amount) && Math.abs(amount) <= 999_999_999_999 ? amount : null
}

function historyOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    return !url.username &&
      !url.password &&
      ['https://www.hyundaicard.com', 'https://hyundaicard.com'].includes(url.origin) &&
      url.pathname === HISTORY_PATH
      ? url.origin
      : null
  } catch {
    return null
  }
}

/** Parse only the observed rcntAvItm/avUseItm response, never hidden HTML or arbitrary nested objects. */
export function parseHyundaiApiPage(response: unknown): HyundaiApiPage {
  const body = own(response, 'bdy') ?? response
  const items = own(body, 'rcntAvItm')
  if (!Array.isArray(items) || items.length > MAX_ROWS)
    return { rows: [], issues: ['response_schema_unverified'], rowCount: null, reportedTotal: null }
  if (scalar(own(body, 'error_code')) && scalar(own(body, 'error_message')))
    return { rows: [], issues: ['service_error'], rowCount: null, reportedTotal: null }
  const rows: CardApiRow[] = []
  const issues = new Set<string>()
  const totalText = scalar(own(own(body, 'rcntSummaryInfo'), 'totUseCnt'), 10)
  const reportedTotal =
    totalText && /^\d+$/.test(totalText) && Number.isSafeInteger(Number(totalText))
      ? Number(totalText)
      : null
  if (reportedTotal === null) issues.add('total_count_unverified')
  else if (reportedTotal !== items.length) issues.add('total_count_mismatch')
  const seen = new Map<string, CardApiRow>()
  for (const item of items) {
    const raw = own(item, 'avUseItm')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      issues.add('unrecognized_rows')
      continue
    }
    const day = date(own(raw, 'avDt'))
    const clock = scalar(own(raw, 'avHmsc'), 10)
    const combined = dateTime(own(raw, 'avDttm'))
    const fromParts = day && clock ? dateTime(`${day}${clock}`) : day
    const approvedAt = combined ?? fromParts
    const amount = won(own(raw, 'avAmt'))
    const displayMerchant = scalar(own(raw, 'useMrchNm'), 500)
    const merchant = displayMerchant || scalar(own(raw, 'mrchNm'), 500)
    if (!approvedAt || amount === null || !merchant) {
      issues.add('invalid_transaction_row')
      continue
    }
    const review: string[] = []
    const approvalClass = scalar(own(raw, 'avClsf'), 10)
    const cancelled = approvalClass === '1' || approvalClass === '3'
    const approved = approvalClass === '0' || approvalClass === '2'
    const status: CardApiRow['status'] = cancelled ? 'cancelled' : approved ? 'approved' : 'unknown'
    if (!approved && !cancelled) review.push('approval_status_unverified')
    const currency = scalar(own(raw, 'acplCrncCd'), 10)
    const isKrw = currency === 'KRW' || currency === '410'
    if (!isKrw) review.push('currency_unverified')
    if (!displayMerchant) review.push('merchant_source_unverified')
    if (!combined) review.push('approval_datetime_unverified')
    const loan = ['5', '7'].includes(scalar(own(raw, 'useClsf'), 10) || '')
    if (loan) review.push('loan_not_expense')
    if (amount < 0) review.push('amount_basis_unverified')
    if (day && approvedAt.slice(0, 10) !== day) review.push('approval_date_conflict')
    if (approvedAt.length === 10) review.push('approval_time_unavailable')
    const approvalNumber = scalar(own(raw, 'avNo'), 80)
    const cardNumber = scalar(own(raw, 'cdno'), 128)
    const cardReference = scalar(own(raw, 'crno'), 128)
    const cardLabel = scalar(own(raw, 'cardNm'), 200)
    // Official renderer uses the final four characters of cdno, including masked formats.
    const tail = cardNumber ? /(\d{4})$/.exec(cardNumber)?.[1] : null
    if (!approvalNumber || (!cardNumber && !cardReference)) review.push('identity_unverified')
    if (!tail) review.push('card_last4_unavailable')
    const cancelledAt = dateTime(own(raw, 'cancDttm'))
    const eventDate = cancelled ? cancelledAt?.slice(0, 10) : undefined
    if (cancelled) {
      review.push(
        'cancellation_amount_unverified',
        'cancellation_query_basis_unverified',
        'cross_source_cancellation_match_required'
      )
      if (!eventDate) review.push('cancellation_event_date_unavailable')
    } else if (cancelledAt) review.push('cancellation_state_conflict')
    const identity = [
      'hyundai_card',
      cancelled ? 'cancellation' : 'approval',
      cardReference || cardNumber || '',
      approvedAt,
      approvalNumber || '',
      cancelled ? cancelledAt || '' : ''
    ]
    if (!approvalNumber || (!cardNumber && !cardReference)) identity.push(merchant, String(amount))
    const row: CardApiRow = {
      issuer: 'hyundai_card',
      sourceId: `hyundai_card:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`,
      kind: cancelled ? 'cancellation' : approved ? 'approval' : 'status',
      approvedAt,
      ...(eventDate ? { eventDate } : {}),
      ...(approvalNumber ? { approvalNumber } : {}),
      ...(tail ? { cardLast4: tail } : {}),
      ...(cardLabel ? { cardLabel } : {}),
      merchant,
      amount: Math.abs(amount),
      currency: 'KRW',
      status,
      cancellationAmount: null,
      netAmount: approved && isKrw && !loan && amount >= 0 ? amount : null,
      needsReview: review
    }
    const previous = seen.get(row.sourceId)
    if (previous) {
      if (!previous.needsReview.includes('duplicate_source_identity'))
        previous.needsReview.push('duplicate_source_identity')
      row.needsReview.push('duplicate_source_identity')
      issues.add('duplicate_source_identity')
    }
    seen.set(row.sourceId, row)
    rows.push(row)
  }
  if (rows.length >= 630) issues.add('daily_row_limit_possible')
  return { rows, issues: [...issues], rowCount: items.length, reportedTotal }
}

/** Fixed main-process transport; cookies stay within this tab's Electron session. */
export async function requestHyundaiApiPage(
  tab: Tab,
  form: HyundaiApiForm,
  signal?: AbortSignal
): Promise<unknown> {
  if (signal?.aborted) throw new Error('hyundai_request_cancelled')
  const keys = Object.keys(form)
  if (
    keys.length !== REQUEST_FIELDS.length ||
    keys.some((key) => !(REQUEST_FIELDS as readonly string[]).includes(key))
  )
    throw new Error('hyundai_request_invalid')
  const body = new URLSearchParams()
  for (const key of REQUEST_FIELDS) {
    const value = own(form, key)
    if (
      typeof value !== 'string' ||
      value.length > 256 ||
      [...value].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      )
    )
      throw new Error('hyundai_request_invalid')
    body.set(key, value)
  }
  const start = date(form.srtDt)
  const end = date(form.endDt)
  if (!start || !end || start > end || Date.parse(end) - Date.parse(start) > 3 * 86_400_000)
    throw new Error('hyundai_request_invalid')
  const wc = tab.view.webContents
  const origin = !wc.isDestroyed() && historyOrigin(wc.getURL())
  if (!origin) throw new Error('hyundai_history_required')
  const initialUrl = wc.getURL()
  const endpoint = origin + QUERY_PATH
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), 20_000)
  timer.unref?.()
  const combinedSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
  const assertContext = (): void => {
    if (signal?.aborted) throw new Error('hyundai_request_cancelled')
    if (timeout.signal.aborted) throw new Error('hyundai_request_timeout')
    if (wc.isDestroyed() || wc.getURL() !== initialUrl)
      throw new Error('hyundai_navigation_changed')
  }
  let response: Response | undefined
  try {
    const auth = await bounded(pageBridge.hyundaiAuth(tab), combinedSignal)
    assertContext()
    if (auth.state !== 'signed_in') throw new Error('hyundai_authentication_required')
    response = await wc.session.fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: origin + HISTORY_PATH
      },
      body: body.toString(),
      signal: combinedSignal
    })
    assertContext()
    if (!response.ok || (response.url && response.url !== endpoint) || !response.body)
      throw new Error('hyundai_response_unavailable')
    const contentType = response.headers.get('content-type') ?? ''
    if (!/^(?:application|text)\/json(?:;|$)/i.test(contentType))
      throw new Error('hyundai_response_unavailable')
    const length = response.headers.get('content-length')
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES))
      throw new Error('hyundai_response_limit')
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let bytes = 0
    try {
      while (true) {
        assertContext()
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > MAX_RESPONSE_BYTES) throw new Error('hyundai_response_limit')
        chunks.push(Buffer.from(chunk.value))
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
    assertContext()
    const finalAuth = await bounded(pageBridge.hyundaiAuth(tab), combinedSignal)
    assertContext()
    if (finalAuth.state !== 'signed_in') throw new Error('hyundai_authentication_required')
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error) {
    // Transport/page exceptions can embed URLs, request fields or response text.
    if (signal?.aborted) throw new Error('hyundai_request_cancelled')
    if (timeout.signal.aborted) throw new Error('hyundai_request_timeout')
    if (error instanceof Error && SAFE_ERRORS.has(error.message)) throw new Error(error.message)
    throw new Error('hyundai_request_unavailable')
  } finally {
    clearTimeout(timer)
    await response?.body?.cancel().catch(() => undefined)
  }
}

export const collectHyundaiApi: CardApiCollector = async (tab, range, options = {}) => {
  const started = Date.now()
  const rows: CardApiRow[] = []
  let pages = 0
  const issues = new Set<string>()
  const result = (more: string[] = []): CardApiResult => ({
    rows,
    receipt: {
      issuer: 'hyundai_card',
      range,
      pages,
      rowCount: rows.length,
      complete: issues.size === 0 && more.length === 0,
      approvalComplete: false,
      issues: [...new Set([...issues, ...more])],
      elapsedMs: Date.now() - started
    }
  })
  const from = date(range.from)
  const to = date(range.to)
  if (!from || !to || from > to || Date.parse(to) - Date.parse(from) > 3 * 86_400_000)
    return result(['invalid_range'])
  if (options.signal?.aborted) return result(['cancelled'])
  try {
    const wc = tab.view.webContents
    if (wc.isDestroyed() || !historyOrigin(wc.getURL())) return result(['history_page_required'])
    const url = wc.getURL()
    const auth = await bounded(pageBridge.hyundaiAuth(tab), options.signal)
    if (options.signal?.aborted) return result(['cancelled'])
    if (wc.isDestroyed() || wc.getURL() !== url) return result(['navigation_changed'])
    if (auth.state !== 'signed_in') return result(['authentication_required'])
    const maxPages = Math.min(4, Math.max(0, Math.floor(options.maxPages ?? 4)))
    if (!Number.isFinite(maxPages)) return result(['invalid_page_limit'])
    for (let day = Date.parse(from); day <= Date.parse(to); day += 86_400_000) {
      if (options.signal?.aborted) return result(['cancelled'])
      if (pages >= maxPages) return result(['page_limit'])
      if (wc.isDestroyed() || wc.getURL() !== url) return result(['navigation_changed'])
      const iso = new Date(day).toISOString().slice(0, 10)
      const plan: unknown = await bounded(
        wc.executeJavaScript(requestPlanScript(iso, iso), false),
        options.signal
      )
      if (options.signal?.aborted) return result(['cancelled'])
      if (wc.isDestroyed() || wc.getURL() !== url) return result(['navigation_changed'])
      if (own(plan, 'ok') !== true) {
        const issue = own(plan, 'issue')
        return result([
          issue === 'card_selector_unverified' || issue === 'history_page_required'
            ? issue
            : 'request_schema_unverified'
        ])
      }
      const form = own(plan, 'data') as HyundaiApiForm
      if (!form || typeof form !== 'object') return result(['request_schema_unverified'])
      pages++
      const response = await requestHyundaiApiPage(tab, form, options.signal)
      const page = parseHyundaiApiPage(response)
      for (const issue of page.issues) issues.add(issue)
      if (page.rowCount === null) return result()
      const summary = own(own(response, 'bdy') ?? response, 'rcntSummaryInfo')
      if (date(own(summary, 'srtDt')) !== iso || date(own(summary, 'endDt')) !== iso)
        return result(['response_range_unverified'])
      for (const row of page.rows) {
        const observedDay =
          row.kind === 'cancellation'
            ? row.eventDate || row.approvedAt.slice(0, 10)
            : row.approvedAt.slice(0, 10)
        if (observedDay !== iso) {
          issues.add('approval_outside_requested_range')
          continue
        }
        for (const issue of row.needsReview) issues.add(issue)
        rows.push(row)
      }
    }
    // Daily splitting reduces the known UI limit risk. The separate domestic/foreign
    // selector and authoritative total still need a verified renderer contract.
    return result(['scope_unverified', 'cancellation_query_basis_unverified'])
  } catch (error) {
    if (options.signal?.aborted) return result(['cancelled'])
    return result([
      error instanceof Error && SAFE_ERRORS.has(error.message)
        ? error.message
        : 'collection_unavailable'
    ])
  }
}
