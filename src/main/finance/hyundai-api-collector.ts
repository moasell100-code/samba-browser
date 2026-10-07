import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Tab } from '../browser/tab-manager'
import { pageBridge } from '../browser/page-bridge'
import type { CardApiCollector, CardApiResult, CardApiRow } from './card-api-types'

const HISTORY_PATH = '/cpa/cb/CPACB0101_01.hc'
const QUERY_PATH = '/cpa/cb/apiCPACB0101_21.hc'
const ACQUIRED_QUERY_PATH = '/cpa/cb/apiCPACB0101_22.hc'
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_ROWS = 1000
const ALL_CARD_LABELS = [
  '전체',
  '전체카드',
  '카드전체',
  '모든카드',
  '전체보기',
  '전체카드보기',
  '카드전체보기',
  '전체카드조회',
  '전체조회',
  '카드전체조회',
  '보유카드전체',
  '전체카드선택',
  '카드전체선택'
] as const
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
const cardTailSchema = z
  .object({
    crno: z.string().min(1).max(256),
    status: z.enum(['matched', 'ambiguous', 'unavailable']),
    queryable: z.boolean().optional(),
    diagnostic: z
      .enum([
        'token_matched',
        'token_missing',
        'token_ambiguous',
        'token_tail_masked',
        'token_tail_three_digits',
        'token_tail_partially_masked',
        'token_tail_other',
        'reference_ambiguous'
      ])
      .optional(),
    last4: z
      .string()
      .regex(/^[\d*]{4}$/)
      .refine((value) => /\d/.test(value))
      .optional()
  })
  .strict()
  .refine((value) =>
    value.status === 'matched' ? value.last4 !== undefined : value.last4 === undefined
  )
export type HyundaiCardTail = z.infer<typeof cardTailSchema>
const cardTailsSchema = z.array(cardTailSchema).max(100)

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
    regionFilterEmpty: z.boolean(),
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
  const regions = form ? form.querySelectorAll('input[name="dmfrClsf"]') : [];
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
    regionFilterEmpty: regions.length === 1 && regions[0].type === 'hidden' && regions[0].value === '',
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

export function requestPlanScript(
  from: string,
  to: string,
  listMode: 'recent' | 'acquired' = 'recent'
): string {
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
    if (cards[0].options.length > 100) return fail('card_selector_unverified');
    const cardTails = [];
    for (const option of Array.from(cards[0].options)) {
      if (option === allCards[0] || !option.value) continue;
      if (option.value.length > 256) return fail('card_selector_unverified');
      const label = (option.label || '').replace(/\\s+/g, ' ').trim();
      const runs = Array.from(label.matchAll(/[\\d*Xx●•]+(?:[ -]+[\\d*Xx●•]+)*/g), match => match[0].replace(/[ -]/g, ''));
      const patterns = runs.filter(token => token.length === 15 || token.length === 16);
      if (patterns.length === 1 && /\\d/.test(patterns[0].slice(-4))) cardTails.push({ crno: option.value, status: 'matched', queryable: !option.disabled, diagnostic: /\\d{4}$/.test(patterns[0]) ? 'token_matched' : 'token_tail_partially_masked', last4: patterns[0].slice(-4).replace(/[*Xx●•]/g, '*') });
      else {
        const ambiguous = patterns.length > 1 || runs.some(token => token.length >= 30);
        const last = patterns.length === 1 ? patterns[0].slice(-4) : '';
        const diagnostic = ambiguous ? 'token_ambiguous' : patterns.length === 0 ? 'token_missing' : /[*Xx●•]{4}$/.test(last) ? 'token_tail_masked' : /(?:^|[^\\d])\\d{3}$/.test(patterns[0]) ? 'token_tail_three_digits' : /\\d/.test(last) && /[*Xx●•]/.test(last) ? 'token_tail_partially_masked' : 'token_tail_other';
        cardTails.push({ crno: option.value, status: ambiguous ? 'ambiguous' : 'unavailable', queryable: !option.disabled, diagnostic });
      }
    }
    for (const entry of cardTails) {
      if (cardTails.filter(other => other.crno === entry.crno).length > 1) { entry.status = 'ambiguous'; entry.diagnostic = 'reference_ambiguous'; delete entry.last4; }
    }
    const direct = fixedRadio('dtClsf_04', 'dtClsf', '직접입력');
    const recent = fixedRadio('${listMode === 'acquired' ? 'listClsf_02' : 'listClsf_01'}', 'listClsf', null);
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
    return { ok: true, data, cardTails };
  })()`
}

export interface HyundaiApiPage {
  rows: CardApiRow[]
  issues: string[]
  rowCount: number | null
  reportedTotal: number | null
}

async function bounded<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  timeoutMs = 20_000
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('hyundai_request_timeout')), timeoutMs)
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

/** Only the first DOM plan may be awaiting the site's asynchronous form initialization. */
async function initialRequestPlan(
  tab: Tab,
  wc: Tab['view']['webContents'],
  url: string,
  script: string,
  signal?: AbortSignal
): Promise<unknown> {
  const deadline = Date.now() + 10_000
  const stopped = new AbortController()
  const combined = signal ? AbortSignal.any([signal, stopped.signal]) : stopped.signal
  const assertContext = (): void => {
    if (signal?.aborted) throw new Error('hyundai_request_cancelled')
    if (tab.view.webContents !== wc || wc.isDestroyed() || wc.getURL() !== url)
      throw new Error('hyundai_navigation_changed')
  }
  const watch = setInterval(() => {
    try {
      assertContext()
    } catch {
      stopped.abort()
    }
  }, 250)
  let lastPlan: unknown
  try {
    for (;;) {
      assertContext()
      const remaining = deadline - Date.now()
      if (remaining <= 0) return lastPlan
      let plan: unknown
      try {
        plan = await bounded(wc.executeJavaScript(script, false), combined, remaining)
      } catch (error) {
        assertContext()
        if (error instanceof Error && error.message === 'hyundai_request_timeout' && lastPlan)
          return lastPlan
        throw error
      }
      assertContext()
      const issue = own(plan, 'issue')
      if (
        own(plan, 'ok') !== false ||
        (issue !== 'request_schema_unverified' && issue !== 'card_selector_unverified')
      )
        return plan
      lastPlan = plan
      const delay = Math.min(250, deadline - Date.now())
      if (delay <= 0) return lastPlan
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          clearTimeout(timer)
          combined.removeEventListener('abort', finish)
          resolve()
        }
        const timer = setTimeout(finish, delay)
        if (combined.aborted) finish()
        else combined.addEventListener('abort', finish, { once: true })
      })
    }
  } finally {
    clearInterval(watch)
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
export function parseHyundaiApiPage(
  response: unknown,
  cardTails: readonly HyundaiCardTail[] = []
): HyundaiApiPage {
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
    // The official recentList renderer labels avAmt in 원. acplCrncCd can be
    // blank for that displayed KRW amount; retain review for an explicit other code.
    const isKrw = !currency || currency === 'KRW' || currency === '410'
    if (!isKrw) {
      review.push('currency_unverified')
      review.push(currency ? 'currency_code_unrecognized' : 'currency_code_missing')
    }
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
    // Only a complete, verified-format card token may supply the displayed suffix.
    // Preserve every hidden position as '*'; never reconstruct missing digits.
    const compactNumber = cardNumber?.replace(/[ -]/g, '').replace(/[*Xx•●]/g, '*')
    const normalizedNumber =
      compactNumber && /^[\d*]{15,16}$/.test(compactNumber) ? compactNumber : null
    const displayedSuffix = normalizedNumber?.slice(-4)
    let tail = displayedSuffix && /\d/.test(displayedSuffix) ? displayedSuffix : null
    const cardKey =
      cardReference || normalizedNumber
        ? createHash('sha256')
            .update(
              JSON.stringify([
                'hyundai_card',
                cardReference ? 'crno' : 'cdno',
                cardReference || normalizedNumber
              ])
            )
            .digest('hex')
        : null
    const mapped = cardReference ? cardTails.filter((entry) => entry.crno === cardReference) : []
    if (!tail) {
      // Diagnostic flags describe only shapes and matching outcomes. They are
      // receipt metadata, never row review reasons or raw option/number values.
      issues.add(
        !cardReference
          ? 'card_reference_missing'
          : mapped.length === 0
            ? 'card_reference_option_unmatched'
            : 'card_reference_option_matched'
      )
      if (cardNumber) {
        issues.add(
          cardNumber.length === 15
            ? 'card_cdno_length_15'
            : cardNumber.length === 16
              ? 'card_cdno_length_16'
              : cardNumber.length === 19
                ? 'card_cdno_length_19'
                : 'card_cdno_length_other'
        )
        issues.add(
          [...cardNumber].every((character) => character.charCodeAt(0) <= 127)
            ? 'card_cdno_ascii'
            : 'card_cdno_non_ascii'
        )
        issues.add(
          /(?:^|\D)\d{3}$/.test(cardNumber)
            ? 'card_cdno_tail_three_digits'
            : /[*Xx•●]{4}$/.test(cardNumber)
              ? 'card_cdno_tail_masked'
              : 'card_cdno_tail_other'
        )
        const last = cardNumber.slice(-4)
        if (/^[\d*Xx•●]{4}$/.test(last) && /\d/.test(last) && /[*Xx•●]/.test(last))
          issues.add('card_tail_partially_masked')
      } else issues.add('card_cdno_missing')
      if (
        mapped.length === 1 &&
        mapped[0].diagnostic &&
        [
          'token_matched',
          'token_missing',
          'token_ambiguous',
          'token_tail_masked',
          'token_tail_three_digits',
          'token_tail_partially_masked',
          'token_tail_other',
          'reference_ambiguous'
        ].includes(mapped[0].diagnostic)
      )
        issues.add('card_option_' + mapped[0].diagnostic)
      else if (mapped.length > 1) issues.add('card_option_reference_ambiguous')
    }
    if (mapped.length > 1 || mapped[0]?.status === 'ambiguous')
      review.push('card_mapping_ambiguous')
    else if (mapped[0]?.status === 'matched') {
      const mappedTail = mapped[0].last4
      if (!mappedTail || !/^[\d*]{4}$/.test(mappedTail) || !/\d/.test(mappedTail))
        review.push('card_mapping_unverified')
      else if (
        tail &&
        [...tail].some(
          (character, index) =>
            character !== '*' && mappedTail[index] !== '*' && character !== mappedTail[index]
        )
      ) {
        review.push('card_last4_conflict')
        tail = null
      } else if (!tail) tail = mappedTail
    }
    if (tail?.includes('*')) issues.add('card_tail_partially_masked')
    if (!approvalNumber || (!cardNumber && !cardReference)) review.push('identity_unverified')
    if (!tail) {
      review.push('card_last4_unavailable')
      review.push(
        !cardNumber
          ? 'card_number_missing'
          : /[*Xx•●]{4}$/.test(cardNumber)
            ? 'card_last4_masked'
            : 'card_number_format_unverified'
      )
    }
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
      ...(cardKey ? { cardKey } : {}),
      ...(cardLabel ? { cardLabel } : {}),
      merchant,
      amount: Math.abs(amount),
      currency: 'KRW',
      status,
      cancellationAmount: null,
      ...(cancelled ? { cancellationEvidence: false } : {}),
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
  signal?: AbortSignal,
  mode: 'recent' | 'acquired' = 'recent'
): Promise<unknown> {
  if (signal?.aborted) throw new Error('hyundai_request_cancelled')
  if (mode !== 'recent' && mode !== 'acquired') throw new Error('hyundai_request_invalid')
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
  const endpoint = origin + (mode === 'acquired' ? ACQUIRED_QUERY_PATH : QUERY_PATH)
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), 20_000)
  timer.unref?.()
  const combinedSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
  const assertContext = (): void => {
    if (signal?.aborted) throw new Error('hyundai_request_cancelled')
    if (timeout.signal.aborted) throw new Error('hyundai_request_timeout')
    if (tab.view.webContents !== wc || wc.isDestroyed() || wc.getURL() !== initialUrl)
      throw new Error('hyundai_navigation_changed')
  }
  let response: Response | undefined
  try {
    const auth = await bounded(pageBridge.hyundaiAuth(tab), combinedSignal)
    assertContext()
    if (auth.state !== 'signed_in') throw new Error('hyundai_authentication_required')
    response = await bounded(
      wc.session.fetch(endpoint, {
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
      }),
      combinedSignal
    )
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
        const chunk = await bounded(reader.read(), combinedSignal)
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

function transactionShape(row: CardApiRow): string {
  return JSON.stringify([
    row.issuer,
    row.kind,
    row.approvedAt,
    row.eventDate,
    row.approvalNumber,
    row.cardLast4,
    row.cardKey,
    row.cardLabel,
    row.merchant,
    row.amount,
    row.currency,
    row.status,
    row.cancellationAmount,
    row.cancellationEvidence,
    row.cancellationAmountType,
    row.cancellationEventId,
    row.netAmount
  ])
}

function responseScopeIssue(
  response: unknown,
  form: HyundaiApiForm,
  iso: string,
  mode: 'recent' | 'acquired' = 'recent'
): string | null {
  const summary = own(own(response, 'bdy') ?? response, 'rcntSummaryInfo')
  if (date(own(summary, 'srtDt')) !== iso || date(own(summary, 'endDt')) !== iso)
    return 'response_range_unverified'
  for (const field of ['crno', 'zoneClsf', 'useClsf', 'usplClsf', 'dtClsf'] as const) {
    // The observed acquired response clears this recent-only merchant filter.
    if (mode === 'acquired' && field === 'usplClsf' && own(summary, field) === '') continue
    if (scalar(own(summary, field), 256) !== form[field].trim()) return 'response_scope_unverified'
  }
  return null
}

export interface HyundaiAcquiredInspection {
  state: 'ready' | 'unavailable'
  pages: number
  rowCount: number
  reportedTotal: number | null
  scopeVerified: boolean
  /** Shape observations only: these do not establish refund or date semantics. */
  fields: Array<{
    name: string
    types: string[]
    lengths: string[]
    nonemptyCount: number
    distinctCount: number
    dateShapeCount: number
    requestedDayMatchCount: number
  }>
  amountSigns: { positive: number; negative: number; zero: number; unverified: number }
  issues: string[]
}

/** Fixed acquired query diagnostics. Never returns any scalar response/form/card value. */
export async function inspectHyundaiAcquired(
  tab: Tab,
  range: { from: string; to: string },
  signal?: AbortSignal
): Promise<HyundaiAcquiredInspection> {
  let pages = 0
  let rowCount = 0
  let reportedTotal: number | null = 0
  let scopeVerified = true
  const issues = new Set<string>()
  const amountSigns = { positive: 0, negative: 0, zero: 0, unverified: 0 }
  const fields = new Map<
    string,
    {
      types: Set<string>
      lengths: Set<string>
      nonemptyCount: number
      distinct: Set<string>
      dateShapeCount: number
      requestedDayMatchCount: number
    }
  >()
  const result = (state: HyundaiAcquiredInspection['state']): HyundaiAcquiredInspection => ({
    state,
    pages,
    rowCount,
    reportedTotal,
    scopeVerified,
    fields: [...fields].map(([name, field]) => ({
      name,
      types: [...field.types].sort(),
      lengths: [...field.lengths].sort(),
      nonemptyCount: field.nonemptyCount,
      distinctCount: field.distinct.size,
      dateShapeCount: field.dateShapeCount,
      requestedDayMatchCount: field.requestedDayMatchCount
    })),
    amountSigns,
    issues: [...issues]
  })
  const from = date(range.from)
  const to = date(range.to)
  if (!from || !to || from > to || Date.parse(to) - Date.parse(from) > 3 * 86_400_000) {
    issues.add('invalid_range')
    scopeVerified = false
    return result('unavailable')
  }
  if (signal?.aborted) {
    issues.add('cancelled')
    scopeVerified = false
    return result('unavailable')
  }
  const inspectionTimeout = new AbortController()
  const timer = setTimeout(() => inspectionTimeout.abort(), 60_000)
  timer.unref?.()
  const inspectionSignal = signal
    ? AbortSignal.any([signal, inspectionTimeout.signal])
    : inspectionTimeout.signal
  const observe = (raw: unknown, iso: string, parent = '', depth = 0): void => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    const names = Object.keys(raw)
    if (names.length > 100) issues.add('acquired_diagnostic_fields_truncated')
    for (const name of names.slice(0, 100)) {
      // Schema identifiers only. Dynamic/private keys and credential fields are omitted.
      if (
        !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ||
        /\d{5}|private|password|passwd|secret|token|cookie|credential|session|authorization|csrf/i.test(
          name
        )
      )
        continue
      const path = parent ? `${parent}.${name}` : name
      if (!fields.has(path) && fields.size >= 100) {
        issues.add('acquired_diagnostic_fields_truncated')
        continue
      }
      const descriptor = Object.getOwnPropertyDescriptor(raw, name)
      if (!descriptor || !('value' in descriptor)) continue
      const value: unknown = descriptor.value
      const field = fields.get(path) ?? {
        types: new Set<string>(),
        lengths: new Set<string>(),
        nonemptyCount: 0,
        distinct: new Set<string>(),
        dateShapeCount: 0,
        requestedDayMatchCount: 0
      }
      field.types.add(value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value)
      const text = scalar(value, 2048)
      if (text !== null) {
        field.lengths.add(
          text.length === 0
            ? 'empty'
            : text.length <= 8
              ? '1_8'
              : text.length <= 32
                ? '9_32'
                : text.length <= 128
                  ? '33_128'
                  : '129_plus'
        )
        if (text) {
          field.nonemptyCount++
          field.distinct.add(text)
        }
        const day = dateTime(text)?.slice(0, 10)
        if (day) {
          field.dateShapeCount++
          if (day === iso) field.requestedDayMatchCount++
        }
      }
      fields.set(path, field)
      if (depth < 1) observe(value, iso, path, depth + 1)
    }
  }
  try {
    const wc = tab.view.webContents
    const url = wc.getURL()
    if (wc.isDestroyed() || !historyOrigin(url)) throw new Error('hyundai_history_required')
    const context = (): void => {
      if (signal?.aborted) throw new Error('hyundai_request_cancelled')
      if (inspectionTimeout.signal.aborted) throw new Error('hyundai_request_timeout')
      if (tab.view.webContents !== wc || wc.isDestroyed() || wc.getURL() !== url)
        throw new Error('hyundai_navigation_changed')
    }
    const auth = await bounded(pageBridge.hyundaiAuth(tab), inspectionSignal)
    context()
    if (auth.state !== 'signed_in') throw new Error('hyundai_authentication_required')
    for (let day = Date.parse(from); day <= Date.parse(to); day += 86_400_000) {
      context()
      const iso = new Date(day).toISOString().slice(0, 10)
      const plan: unknown = await bounded(
        wc.executeJavaScript(requestPlanScript(iso, iso, 'acquired'), false),
        inspectionSignal
      )
      context()
      if (own(plan, 'ok') !== true) {
        const issue = own(plan, 'issue')
        throw new Error(issue === 'card_selector_unverified' ? issue : 'request_schema_unverified')
      }
      const form = own(plan, 'data') as HyundaiApiForm
      if (!form || typeof form !== 'object') throw new Error('request_schema_unverified')
      if (date(own(form, 'srtDt')) !== iso || date(own(form, 'endDt')) !== iso)
        throw new Error('request_schema_unverified')
      if (form.dmfrClsf !== '') {
        scopeVerified = false
        issues.add('scope_unverified')
      }
      pages++
      const response = await requestHyundaiApiPage(tab, form, inspectionSignal, 'acquired')
      context()
      const body = own(response, 'bdy') ?? response
      const summary = own(body, 'rcntSummaryInfo')
      const scope = responseScopeIssue(response, form, iso, 'acquired')
      if (scope) {
        scopeVerified = false
        issues.add(scope)
      }
      if (scalar(own(body, 'error_code')) && scalar(own(body, 'error_message')))
        throw new Error('service_error')
      const items = own(body, 'acqrUseItmList')
      if (!Array.isArray(items) || items.length > MAX_ROWS)
        throw new Error('acquired_response_schema_unverified')
      const count = scalar(own(summary, 'totUseCnt'), 10)
      const total =
        count && /^\d+$/.test(count) && Number.isSafeInteger(Number(count)) ? Number(count) : null
      if (total === null) {
        reportedTotal = null
        issues.add('total_count_unverified')
      } else {
        if (reportedTotal !== null) reportedTotal += total
        if (total !== items.length) issues.add('total_count_mismatch')
      }
      rowCount += items.length
      if (Math.max(items.length, total ?? 0) >= 630) issues.add('daily_row_limit_possible')
      for (const item of items) {
        observe(item, iso)
        // The retained official converter/importer establishes this displayed KRW
        // arithmetic. Its sign is diagnostic only, never refund/event-date proof.
        const amount = won(own(item, 'useAmt'))
        const fee = won(own(item, 'excm'))
        if (amount === null || fee === null || !Number.isSafeInteger(amount + fee))
          amountSigns.unverified++
        else if (amount + fee < 0) amountSigns.negative++
        else if (amount + fee > 0) amountSigns.positive++
        else amountSigns.zero++
      }
    }
    issues.add('acquired_cancellation_semantics_unverified')
    return result('ready')
  } catch (error) {
    scopeVerified = false
    const safe = new Set([
      ...SAFE_ERRORS,
      'card_selector_unverified',
      'request_schema_unverified',
      'service_error',
      'acquired_response_schema_unverified'
    ])
    issues.add(
      signal?.aborted
        ? 'hyundai_request_cancelled'
        : inspectionTimeout.signal.aborted
          ? 'hyundai_request_timeout'
          : error instanceof Error && safe.has(error.message)
            ? error.message
            : 'acquired_inspection_unavailable'
    )
    return result('unavailable')
  } finally {
    clearTimeout(timer)
  }
}

function pageCoverageVerified(page: HyundaiApiPage): boolean {
  return (
    page.rowCount !== null &&
    page.rows.length === page.rowCount &&
    page.reportedTotal === page.rowCount &&
    !page.issues.includes('daily_row_limit_possible')
  )
}

export const collectHyundaiApi: CardApiCollector = async (tab, range, options = {}) => {
  const started = Date.now()
  const rows: CardApiRow[] = []
  let pages = 0
  let approvalComplete = false
  let approvalCoverageValid = true
  const issues = new Set<string>()
  const seenRows = new Map<string, CardApiRow>()
  const retain = (row: CardApiRow): void => {
    const previous = seenRows.get(row.sourceId)
    if (previous) {
      previous.needsReview = [...new Set([...previous.needsReview, ...row.needsReview])]
      if (transactionShape(previous) !== transactionShape(row)) {
        if (!previous.needsReview.includes('source_identity_conflict'))
          previous.needsReview.push('source_identity_conflict')
        issues.add('source_identity_conflict')
        approvalCoverageValid = false
      }
      return
    }
    seenRows.set(row.sourceId, row)
    rows.push(row)
  }
  const result = (more: string[] = []): CardApiResult => ({
    rows,
    receipt: {
      issuer: 'hyundai_card',
      range,
      pages,
      rowCount: rows.length,
      complete: issues.size === 0 && more.length === 0,
      approvalComplete,
      cancellationComplete: false,
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
    // At most four daily all-card requests plus ten individual-card requests
    // per day if the observed cap requires a verified split.
    const maxPages = Math.min(44, Math.max(0, Math.floor(options.maxPages ?? 44)))
    if (!Number.isFinite(maxPages)) return result(['invalid_page_limit'])
    for (let day = Date.parse(from); day <= Date.parse(to); day += 86_400_000) {
      if (options.signal?.aborted) return result(['cancelled'])
      if (pages >= maxPages) return result(['page_limit'])
      if (wc.isDestroyed() || wc.getURL() !== url) return result(['navigation_changed'])
      const iso = new Date(day).toISOString().slice(0, 10)
      const plan: unknown =
        pages === 0
          ? await initialRequestPlan(tab, wc, url, requestPlanScript(iso, iso), options.signal)
          : await bounded(wc.executeJavaScript(requestPlanScript(iso, iso), false), options.signal)
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
      const cardTails = cardTailsSchema.safeParse(own(plan, 'cardTails'))
      if (!cardTails.success) return result(['card_mapping_unverified'])
      if (form.dmfrClsf !== '') {
        approvalCoverageValid = false
        issues.add('scope_unverified')
      }
      pages++
      const response = await requestHyundaiApiPage(tab, form, options.signal)
      let page = parseHyundaiApiPage(response, cardTails.data)
      if (page.rowCount === null) return result(page.issues)
      const scopeIssue = responseScopeIssue(response, form, iso)
      if (scopeIssue) return result([scopeIssue])
      let dayCoverage = pageCoverageVerified(page)
      let dayStopIssue: string | null = null
      const capPossible = Math.max(page.rowCount, page.reportedTotal ?? 0) >= 630
      if (!dayCoverage && capPossible) {
        const references = cardTails.data
          .filter((entry) => entry.queryable === true)
          .map((entry) => entry.crno)
        if (
          !references.length ||
          references.length > 10 ||
          new Set(references).size !== references.length ||
          references.includes(form.crno)
        ) {
          issues.add('card_split_scope_unverified')
        } else {
          const original = page
          const splitRows: CardApiRow[] = []
          const splitIssues = new Set<string>()
          let splitValid = true
          let splitCount = 0
          let splitPages = 0
          for (const reference of references) {
            if (pages >= maxPages) {
              splitValid = false
              splitIssues.add('page_limit')
              break
            }
            const cardForm = { ...form, crno: reference }
            pages++
            let cardResponse: unknown
            try {
              cardResponse = await requestHyundaiApiPage(tab, cardForm, options.signal)
            } catch (error) {
              splitValid = false
              dayStopIssue =
                error instanceof Error && SAFE_ERRORS.has(error.message)
                  ? error.message
                  : 'collection_unavailable'
              break
            }
            const cardScopeIssue = responseScopeIssue(cardResponse, cardForm, iso)
            if (cardScopeIssue) {
              splitValid = false
              dayStopIssue = cardScopeIssue
              break
            }
            const part = parseHyundaiApiPage(cardResponse, cardTails.data)
            splitPages++
            for (const issue of part.issues) splitIssues.add(issue)
            if (!pageCoverageVerified(part)) splitValid = false
            const items = own(own(cardResponse, 'bdy') ?? cardResponse, 'rcntAvItm')
            if (
              !Array.isArray(items) ||
              !items.every((item) => scalar(own(own(item, 'avUseItm'), 'crno'), 128) === reference)
            ) {
              splitValid = false
              splitIssues.add('card_split_row_scope_unverified')
            }
            splitCount += part.reportedTotal ?? 0
            splitRows.push(...part.rows)
          }
          const distinct = new Map<string, CardApiRow>()
          for (const row of splitRows) {
            const previous = distinct.get(row.sourceId)
            if (previous) {
              splitValid = false
              splitIssues.add(
                transactionShape(previous) === transactionShape(row)
                  ? 'card_split_duplicate_identity'
                  : 'source_identity_conflict'
              )
            } else distinct.set(row.sourceId, row)
          }
          if (
            splitPages !== references.length ||
            splitCount !== original.reportedTotal ||
            distinct.size !== splitCount
          ) {
            splitValid = false
            splitIssues.add('card_split_total_mismatch')
          }
          // Do not merge two moving snapshots into apparently complete data.
          if (
            !original.rows.every((row) => {
              const counterpart = distinct.get(row.sourceId)
              const unchanged =
                counterpart && transactionShape(counterpart) === transactionShape(row)
              if (
                counterpart &&
                !unchanged &&
                !row.needsReview.includes('source_identity_conflict')
              )
                row.needsReview.push('source_identity_conflict')
              return unchanged
            })
          ) {
            splitValid = false
            splitIssues.add('card_split_snapshot_changed')
          }
          for (const issue of splitIssues) issues.add(issue)
          if (splitValid) {
            page = {
              rows: splitRows,
              issues: [...splitIssues],
              rowCount: splitCount,
              reportedTotal: splitCount
            }
            dayCoverage = true
            issues.add('card_split_verified')
          } else {
            issues.add('card_split_incomplete')
            // Keep already validated observations even when a later split fails.
            // The entire partial set is quarantined, not silently lost or booked.
            const partial = [...original.rows, ...splitRows]
            for (const row of partial)
              if (!row.needsReview.includes('card_split_incomplete'))
                row.needsReview.push('card_split_incomplete')
            page = { ...original, rows: partial }
          }
        }
      }
      for (const issue of page.issues) issues.add(issue)
      if (!dayCoverage) approvalCoverageValid = false
      for (const row of page.rows) {
        const approvedDay = row.approvedAt.slice(0, 10)
        const inRequestedDay =
          approvedDay === iso || (row.kind === 'cancellation' && row.eventDate === iso)
        if (!inRequestedDay) {
          issues.add('approval_outside_requested_range')
          approvalCoverageValid = false
          continue
        }
        if (
          row.kind === 'cancellation' &&
          !row.needsReview.includes('cancellation_query_basis_unverified')
        )
          row.needsReview.push('cancellation_query_basis_unverified')
        for (const issue of row.needsReview) issues.add(issue)
        retain(row)
      }
      if (dayStopIssue) return result([dayStopIssue])
    }
    // Whole-card/zone/use controls, direct date range, total and their response
    // echoes are verified. A nonempty secondary region control remains unverified.
    approvalComplete = approvalCoverageValid
    return result(['cancellation_query_basis_unverified'])
  } catch (error) {
    if (options.signal?.aborted) return result(['cancelled'])
    return result([
      error instanceof Error && SAFE_ERRORS.has(error.message)
        ? error.message
        : 'collection_unavailable'
    ])
  }
}
