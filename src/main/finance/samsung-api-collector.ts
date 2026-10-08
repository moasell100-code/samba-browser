import { createHash } from 'node:crypto'
import { z } from 'zod'
import { pageBridge } from '../browser/page-bridge'
import type { CardApiCollector, CardApiResult, CardApiRow, CardDateRange } from './card-api-types'

const ISSUER = 'samsung_card' as const
const HISTORY_PATH = '/personal/card/activity/UHPPRP0801M0.jsp'
const PAGE_SIZE = 10
const REQUEST_MS = 15_000
const RUN_MS = 120_000
const INITIAL_SESSION_WAIT_MS = 10_000
const SESSION_POLL_MS = 250
const MAX_ROWS = 10_000
type Mode = 'approval' | 'cancellation' | 'overseas_cancellation'

const cell = z.union([z.string().max(2000), z.number().finite(), z.null()])
const rawRowSchema = z
  .object({
    aprDt: cell,
    aprT: cell,
    aprno: cell,
    aprAm: cell,
    mrcNm: cell,
    itgCdnoe: cell,
    cdnoId: cell,
    canRcpdt: cell,
    poCanDvC: cell,
    canProcsStsC: cell
  })
  .strict()
type RawRow = z.infer<typeof rawRowSchema>
const detailSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      rows: z.array(z.object({ aprPoCanDtm: cell, aprPoCanAm: cell }).strict()).max(1000),
      pagingFieldsPresent: z.boolean()
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      issue: z.enum([
        'not_history_page',
        'page_not_ready',
        'request_timeout',
        'service_error',
        'invalid_response'
      ])
    })
    .strict()
])
type CancellationDetail = Extract<z.infer<typeof detailSchema>, { ok: true }>
const diagnosticSchema = z
  .object({
    totalType: z.enum(['missing', 'null', 'string', 'number', 'other']),
    total: z.number().int().min(0).max(MAX_ROWS).nullable(),
    sourceType: z.enum(['missing', 'null', 'array', 'object', 'other']),
    rowCount: z.number().int().min(0).max(MAX_ROWS).nullable(),
    cursors: z
      .array(
        z.enum(['missing', 'null', 'empty', 'whitespace', 'nonempty_string', 'number', 'other'])
      )
      .max(9)
  })
  .strict()
type PageDiagnostic = z.infer<typeof diagnosticSchema>
type StreamDiagnostic = {
  pages: (PageDiagnostic & { page: number; observedRows: number })[]
  decision: string
}
const pageSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      total: z.number().int().min(0).max(MAX_ROWS),
      rows: z.array(rawRowSchema).max(PAGE_SIZE),
      /** S13 counts only; foreign refund semantics are not imported as domestic KRW. */
      rowCount: z.number().int().min(0).max(PAGE_SIZE).optional(),
      cursors: z.array(z.string().max(4000)).max(9),
      scope: z.string().regex(/^[a-f0-9]{64}$/),
      diagnostic: diagnosticSchema.optional()
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      issue: z.enum([
        'not_history_page',
        'page_not_ready',
        'card_scope_not_all',
        'card_scope_changed',
        'request_timeout',
        'service_error',
        'invalid_response'
      ]),
      serviceFailure: z
        .enum([
          'response_missing',
          'common_response_rejected',
          'ajax_callback_error',
          'invocation_exception'
        ])
        .optional(),
      diagnostic: diagnosticSchema.optional()
    })
    .strict()
])

function text(value: z.infer<typeof cell>): string {
  return value === null ? '' : String(value).trim()
}

function isoDate(value: string): string | null {
  const compact = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.replaceAll('-', '') : value
  if (!/^\d{8}$/.test(compact)) return null
  const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`
  const date = new Date(`${iso}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null
}

function validRange(range: CardDateRange): CardDateRange | null {
  const from = isoDate(range.from)
  const to = isoDate(range.to)
  if (!from || !to) return null
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000
  return days >= 0 && days <= 3 ? { from, to } : null
}

function isHistoryUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.origin === 'https://www.samsungcard.com' &&
      !url.username &&
      !url.password &&
      url.pathname === HISTORY_PATH
    )
  } catch {
    return false
  }
}

function digest(parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

function won(value: RawRow['aprAm']): number | null {
  const raw = text(value)
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(raw)) return null
  const amount = Number(raw.replaceAll(',', ''))
  return Number.isSafeInteger(amount) && Math.abs(amount) <= 999_999_999_999 ? amount : null
}

/** Fixed shape labels only, never a card value, suffix, length value, or card name. */
function unavailableCardIdentityShape(raw: RawRow['itgCdnoe']): string[] {
  if (typeof raw !== 'string') return ['card_identity_not_string']
  const issues = [
    raw.length === 15
      ? 'card_number_length_15'
      : raw.length === 16
        ? 'card_number_length_16'
        : raw.length === 19
          ? 'card_number_length_19'
          : 'card_number_length_other'
  ]
  if (/\d{4}$/.test(raw)) issues.push('card_tail_digits_available')
  const officialTail = raw.slice(12, 16)
  if (/^\d{4}$/.test(officialTail)) issues.push('card_official_tail_digits_available')
  if (raw.length === 15 && /^\d{3}$/.test(officialTail)) {
    issues.push('card_official_tail_3_digits')
    if (/[*Xx•]/.test(raw.slice(0, 12))) issues.push('card_prefix_masked')
  }
  if (/[*Xx•]/.test(officialTail)) issues.push('card_tail_masked')
  if (officialTail !== raw.trim().slice(12, 16)) issues.push('card_last4_shift_after_trim')
  return issues
}

function normalize(raw: RawRow, mode: Exclude<Mode, 'overseas_cancellation'>): CardApiRow | null {
  const date = isoDate(text(raw.aprDt))
  const signedAmount = won(raw.aprAm)
  const merchant = text(raw.mrcNm)
  if (!date || signedAmount === null || !merchant || merchant.length > 500) return null
  const review: string[] = []
  const time = text(raw.aprT)
  const timeIsValid = /^(?:[01]\d|2[0-3])[0-5]\d[0-5]\d$/.test(time)
  const approvedAt = timeIsValid
    ? `${date}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}+09:00`
    : date
  if (!timeIsValid) review.push('approval_time_unavailable')
  const approvalNumber = text(raw.aprno)
  const cardIdentity = text(raw.itgCdnoe)
  if (!approvalNumber || !cardIdentity) review.push('stable_approval_identity_unavailable')
  // This exact position is used by Samsung's public D0/D8 renderer. Do not export the full card.
  const tail = cardIdentity.slice(12, 16)
  // The official renderer's fixed offset leaves only three characters on a
  // 15-position card. Preserve its actual masked fourth position, not a guess.
  const maskedTail = /^[\d*]{15,16}$/.test(cardIdentity) ? cardIdentity.slice(-4) : ''
  const cardLast4 = /^\d{4}$/.test(tail)
    ? tail
    : /^[\d*]{4}$/.test(maskedTail) && /\d/.test(maskedTail)
      ? maskedTail
      : undefined
  if (!cardLast4)
    review.push('card_last4_unavailable', ...unavailableCardIdentityShape(raw.itgCdnoe))
  const cancellation = mode === 'cancellation' || signedAmount < 0
  const canDateRaw = text(raw.canRcpdt)
  const eventDate = canDateRaw ? isoDate(canDateRaw) : null
  let status: CardApiRow['status'] = 'approved'
  let verifiedFullCancellation = false
  if (cancellation) {
    review.push('cancellation_amount_unverified', 'cross_source_cancellation_match_required')
    if (mode === 'cancellation') review.push('cancellation_query_basis_unverified')
    else review.push('amount_basis_unverified')
    if (!eventDate) review.push('cancellation_event_date_unavailable')
    const process = text(raw.canProcsStsC)
    if (mode === 'cancellation' && process !== '1' && process !== '2') {
      status = 'unknown'
      review.push(process === '3' ? 'cancellation_pending' : 'cancellation_status_unrecognized')
    } else if (['1', '2'].includes(text(raw.poCanDvC))) {
      status = 'partially_cancelled'
    } else if (
      mode === 'cancellation' &&
      (typeof raw.poCanDvC !== 'string' || raw.poCanDvC.trim() !== '')
    ) {
      status = 'unknown'
      review.push(
        raw.poCanDvC === null
          ? 'cancellation_partial_flag_unavailable'
          : 'cancellation_partial_flag_unrecognized'
      )
    } else {
      status = 'cancelled'
      // D8 repeats the whole approval amount. Only a completed, explicitly
      // nonpartial cancellation with an explicit blank string (possibly padded)
      // can prove that the whole amount was refunded. Missing flags stay unproved.
      verifiedFullCancellation =
        mode === 'cancellation' && signedAmount !== 0 && !!eventDate && eventDate >= date
    }
  }
  if (verifiedFullCancellation) {
    for (const issue of [
      'cancellation_amount_unverified',
      'cross_source_cancellation_match_required',
      'cancellation_query_basis_unverified'
    ]) {
      const index = review.indexOf(issue)
      if (index !== -1) review.splice(index, 1)
    }
  }
  // Separate observations from the two services: their amounts must never be added as two refunds.
  const identity = [
    ISSUER,
    mode,
    cancellation ? 'cancellation' : 'approval',
    cardIdentity,
    date,
    timeIsValid ? time : '',
    approvalNumber,
    cancellation ? eventDate || '' : ''
  ]
  if (!approvalNumber || !cardIdentity) identity.push(merchant, String(signedAmount))
  return {
    issuer: ISSUER,
    sourceId: `${ISSUER}:${digest(identity)}`,
    kind: cancellation ? 'cancellation' : 'approval',
    approvedAt,
    ...(eventDate && cancellation ? { eventDate } : {}),
    ...(approvalNumber ? { approvalNumber } : {}),
    ...(cardIdentity ? { cardKey: digest([ISSUER, cardIdentity]) } : {}),
    ...(cardLast4 ? { cardLast4 } : {}),
    merchant,
    amount: Math.abs(signedAmount),
    currency: 'KRW',
    status,
    cancellationAmount: verifiedFullCancellation ? Math.abs(signedAmount) : null,
    ...(verifiedFullCancellation
      ? { cancellationEvidence: true, cancellationAmountType: 'cumulative' as const }
      : {}),
    netAmount: verifiedFullCancellation ? 0 : cancellation ? null : signedAmount,
    needsReview: review
  }
}

/**
 * Fixed read-only services from official UHPPRP0801D0.js (S51) and D8.js (S12).
 * ENV is read without changing page filters. scard.ajax supplies its own session/common envelope.
 * Only whitelisted response fields cross to private main-process memory, never to an agent response.
 */
function pageScript(
  mode: Mode,
  range: CardDateRange,
  page: number,
  cursors: string[],
  diagnostics = false
): string {
  const input = JSON.stringify({
    mode,
    from: range.from.replaceAll('-', ''),
    to: range.to.replaceAll('-', ''),
    page,
    cursors,
    diagnostics
  })
  return `(async () => {
    const input = ${input};
    let diagnostic;
    const fail = (issue, serviceFailure) => ({ ok: false, issue, ...(serviceFailure ? { serviceFailure } : {}), ...(diagnostic ? { diagnostic } : {}) });
    const url = new URL(location.href);
    if (url.origin !== 'https://www.samsungcard.com' || url.username || url.password || url.pathname !== '${HISTORY_PATH}') return fail('not_history_page');
    if (typeof scard !== 'object' || typeof scard.ajax !== 'function' || typeof ENV !== 'object' || !ENV.CONDITION || !crypto.subtle) return fail('page_not_ready');
    const condition = ENV.CONDITION;
    const data = {};
    const scopeKeys = ['cardDvC','cardKndC','isCstMngtNo','pssCstMngtNo','cardCntrNo'];
    for (const key of scopeKeys) {
      const value = condition[key];
      if ((typeof value !== 'string' && typeof value !== 'number') || String(value).length > 100) return fail('page_not_ready');
      data[key] = value;
    }
    if (String(data.cardCntrNo).trim() !== '0' || String(data.pssCstMngtNo).trim() !== '0') return fail('card_scope_not_all');
    const scopeSnapshot = scopeKeys.map(key => String(data[key]));
    const sameScope = () => typeof ENV === 'object' && ENV.CONDITION && scopeKeys.every((key,index) => String(ENV.CONDITION[key]) === scopeSnapshot[index]);
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(scopeSnapshot)));
    const scope = Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
    if (location.href !== url.href) return fail('not_history_page');
    if (!sameScope()) return fail('card_scope_changed');
    Object.assign(data, { inqrStrtdt: input.from, inqrEnddt: input.to, no1PgeSize: ${PAGE_SIZE} });
    const approval = input.mode === 'approval';
    const overseas = input.mode === 'overseas_cancellation';
    const cursorCount = approval ? 9 : overseas ? 4 : 7;
    for (let n = 1; n <= cursorCount; n++) data['no' + n + 'NextKeyCn'] = input.cursors[n - 1] || '';
    if (input.page > 1) Object.assign(data, { pgeNo: input.page, prtgPrvwYn: '' });
    if (approval) Object.assign(data, { strtAm: -99999999999, endAm: 99999999999, dtAry: '', amAry: '', cardUIzInqrDvC: 'Z', fpyIstmIz: { cardUMthDvC: '00', fpyIstmDvC: ' ' } });
    else if (overseas) Object.assign(data, { canDvC: '', cardUIzInqrDvC: '3' });
    else Object.assign(data, { canDvC: '', cardUIzInqrDvC: 'H', domCanIz: { cardUMthDvC: '00', canDvC: '' } });
    return await new Promise(resolve => {
      let settled = false;
      const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
      const timer = setTimeout(() => finish(fail('request_timeout')), ${REQUEST_MS});
      try {
        scard.ajax({
          service: approval ? 'SHPPRP0801S51' : overseas ? 'SHPPRP0801S13' : 'SHPPRP0801S12',
          data,
          timeout: ${REQUEST_MS},
          success: response => {
            try {
              if (location.href !== url.href) return finish(fail('not_history_page'));
              if (!sameScope()) return finish(fail('card_scope_changed'));
              if (!response || typeof response !== 'object') return finish(fail('service_error', 'response_missing'));
              if (response.common && String(response.common.procsRsDvC) !== '0') return finish(fail('service_error', 'common_response_rejected'));
              const key = approval ? 'hppRPCardUIzSub01SVO' : overseas ? 'hppRPFrnCanIzSub01SVO' : 'hppRPDomCanIzSub01SVO';
              if (input.diagnostics) {
                const own = key => Object.prototype.hasOwnProperty.call(response, key);
                const rawTotal = response.totDlngCt;
                const numericTotal = /^(?:0|[1-9]\\d*)$/.test(String(rawTotal)) ? Number(rawTotal) : null;
                const source = response[key];
                diagnostic = {
                  totalType: !own('totDlngCt') ? 'missing' : rawTotal === null ? 'null' : typeof rawTotal === 'string' ? 'string' : typeof rawTotal === 'number' ? 'number' : 'other',
                  total: Number.isSafeInteger(numericTotal) && numericTotal >= 0 && numericTotal <= ${MAX_ROWS} ? numericTotal : null,
                  sourceType: !own(key) ? 'missing' : source === null ? 'null' : Array.isArray(source) ? 'array' : typeof source === 'object' ? 'object' : 'other',
                  rowCount: Array.isArray(source) && source.length <= ${MAX_ROWS} ? source.length : null,
                  cursors: Array.from({ length: cursorCount }, (_, i) => {
                    const key = 'no' + (i + 1) + 'NextKeyCn';
                    const value = response[key];
                    return !own(key) ? 'missing' : value === null ? 'null' : value === '' ? 'empty' : typeof value === 'string' ? value.trim() === '' ? 'whitespace' : 'nonempty_string' : typeof value === 'number' ? 'number' : 'other';
                  })
                };
              }
              const totalText = String(response.totDlngCt ?? '');
              if (!/^\\d+$/.test(totalText)) return finish(fail('invalid_response'));
              const total = Number(totalText);
              if (!Number.isSafeInteger(total) || total > ${MAX_ROWS}) return finish(fail('invalid_response'));
              if (overseas && !Object.prototype.hasOwnProperty.call(response, key)) return finish(fail('invalid_response'));
              const source = response[key] == null && total === 0 ? [] : response[key];
              if (!Array.isArray(source) || source.length > ${PAGE_SIZE}) return finish(fail('invalid_response'));
              const fields = ['aprDt','aprT','aprno','aprAm','mrcNm','itgCdnoe','cdnoId','canRcpdt','poCanDvC','canProcsStsC'];
              const rows = overseas ? [] : source.map(row => {
                if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error();
                const result = {};
                for (const field of fields) {
                  const value = row[field] ?? null;
                  if (value !== null && typeof value !== 'string' && typeof value !== 'number') throw new Error();
                  if (typeof value === 'string' && value.length > 2000) throw new Error();
                  result[field] = value;
                }
                return result;
              });
              const next = [];
              if (overseas && source.some(row => !row || typeof row !== 'object' || Array.isArray(row))) return finish(fail('invalid_response'));
              for (let n = 1; n <= cursorCount; n++) {
                const value = overseas ? response['no' + n + 'NextKeyCn'] : response['no' + n + 'NextKeyCn'] ?? '';
                if (typeof value !== 'string' || value.length > 4000) return finish(fail('invalid_response'));
                // The provider returns fixed-width spaces for absent cursor
                // slots. Preserve every meaningful cursor byte for replay.
                next.push(value.trim() === '' ? '' : value);
              }
              finish({ ok: true, total, rows, cursors: next, scope, ...(overseas ? { rowCount: source.length } : {}), ...(diagnostic ? { diagnostic } : {}) });
            } catch { finish(fail('invalid_response')); }
          },
          error: () => finish(fail('service_error', 'ajax_callback_error'))
        });
      } catch { finish(fail('service_error', 'invocation_exception')); }
    });
  })()`
}

/** Exact read-only popup contract from official UHPPRP0803L0.jsp. */
function detailScript(raw: RawRow): string {
  const input = JSON.stringify({
    aprDt: text(raw.aprDt).replaceAll('-', ''),
    cdnoId: text(raw.cdnoId),
    aprT: text(raw.aprT),
    aprno: text(raw.aprno)
  })
  return `(async () => {
    const input = ${input};
    const fail = issue => ({ ok: false, issue });
    const url = new URL(location.href);
    if (url.origin !== 'https://www.samsungcard.com' || url.username || url.password || url.pathname !== '${HISTORY_PATH}') return fail('not_history_page');
    if (typeof scard !== 'object' || typeof scard.ajax !== 'function' || typeof scard.decodeXss !== 'function') return fail('page_not_ready');
    let data;
    try { data = { ...input, cdnoId: decodeURIComponent(scard.decodeXss(input.cdnoId)) }; }
    catch { return fail('invalid_response'); }
    return await new Promise(resolve => {
      let settled = false;
      const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
      const timer = setTimeout(() => finish(fail('request_timeout')), ${REQUEST_MS});
      try {
        scard.ajax({
          service: 'SHPPRP0801S41', data, timeout: ${REQUEST_MS},
          success: response => {
            try {
              if (!response || typeof response !== 'object' || (response.common && String(response.common.procsRsDvC) !== '0')) return finish(fail('service_error'));
              const source = response.hppRPPoCanIzSub01SVO;
              if (!Array.isArray(source) || source.length > 1000) return finish(fail('invalid_response'));
              const rows = source.map(row => {
                if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error();
                const result = {};
                for (const field of ['aprPoCanDtm','aprPoCanAm']) {
                  const value = row[field] ?? null;
                  if (value !== null && typeof value !== 'string' && typeof value !== 'number') throw new Error();
                  if (typeof value === 'string' && value.length > 2000) throw new Error();
                  result[field] = value;
                }
                return result;
              });
              const pagingFieldsPresent = Object.keys(response).some(key => /^(?:no[1-9]NextKeyCn|totDlngCt|pgeNo)$/.test(key));
              finish({ ok: true, rows, pagingFieldsPresent });
            } catch { finish(fail('invalid_response')); }
          },
          error: () => finish(fail('service_error'))
        });
      } catch { finish(fail('service_error')); }
    });
  })()`
}

function detailIdentityAvailable(raw: RawRow): boolean {
  return (
    !!text(raw.cdnoId) &&
    !!text(raw.aprno) &&
    /^(?:[01]\d|2[0-3])[0-5]\d[0-5]\d$/.test(text(raw.aprT))
  )
}

function detailEventDate(value: z.infer<typeof cell>): string | null {
  const stamp = text(value)
  if (!/^\d{14}$/.test(stamp) || !/^(?:[01]\d|2[0-3])[0-5]\d[0-5]\d$/.test(stamp.slice(8)))
    return null
  return isoDate(stamp.slice(0, 8))
}

function applySingleDetail(row: CardApiRow, raw: RawRow, detail: CancellationDetail): void {
  if (detail.pagingFieldsPresent) {
    row.needsReview.push('cancellation_detail_pagination_unverified')
    return
  }
  if (detail.rows.length !== 1) {
    row.needsReview.push(
      detail.rows.length
        ? 'cancellation_detail_multiple_events_unverified'
        : 'cancellation_detail_empty'
    )
    return
  }
  const event = detail.rows[0]
  const eventDate = detailEventDate(event.aprPoCanDtm)
  const amount = won(event.aprPoCanAm)
  if (
    !eventDate ||
    eventDate < row.approvedAt.slice(0, 10) ||
    eventDate !== row.eventDate ||
    amount === null ||
    Math.abs(amount) === 0 ||
    Math.abs(amount) >= row.amount
  ) {
    row.needsReview.push('cancellation_detail_evidence_mismatch')
    return
  }
  row.cancellationAmount = Math.abs(amount)
  row.netAmount = row.amount - row.cancellationAmount
  row.cancellationEvidence = true
  row.cancellationAmountType = 'cumulative'
  row.cancellationEventId = digest([
    ISSUER,
    text(raw.cdnoId),
    text(raw.aprDt),
    text(raw.aprT),
    text(raw.aprno),
    text(event.aprPoCanDtm)
  ])
  row.needsReview = row.needsReview.filter(
    (issue) =>
      ![
        'cancellation_amount_unverified',
        'cross_source_cancellation_match_required',
        'cancellation_query_basis_unverified'
      ].includes(issue)
  )
}

/** Fixed shape diagnostics only. No approval/card identifiers, amounts or timestamps leave main. */
export async function probeSamsungCancellationDetails(
  tab: Parameters<CardApiCollector>[0],
  suppliedRange: CardDateRange
): Promise<{
  ok: boolean
  issue?: string
  detailRows?: number
  validTimestampRows?: number
  validAmountRows?: number
  duplicateTimestampRows?: number
  pagingFieldsPresent?: boolean
  firstPageRows?: number
  reportedTotal?: number
  partialFlags?: {
    missing: number
    emptyString: number
    whitespace: number
    code0: number
    code1: number
    code2: number
    flagN: number
    flagY: number
    other: number
  }
  processingStates?: {
    missing: number
    empty: number
    completedApproval: number
    completedPayment: number
    pending: number
    other: number
  }
  partialCandidates?: number
  detailIdentityCandidates?: number
  streams?: Partial<Record<Mode, StreamDiagnostic>>
}> {
  const range = validRange(suppliedRange)
  if (!range) return { ok: false, issue: 'invalid_date_range' }
  const wc = tab.view.webContents
  const initialUrl = wc.getURL()
  const guard = async (): Promise<void> => {
    if (
      wc.isDestroyed() ||
      tab.view.webContents !== wc ||
      wc.getURL() !== initialUrl ||
      !isHistoryUrl(initialUrl)
    )
      throw new QueryStopped('navigation_changed')
    const auth = await bounded(pageBridge.cardSession(tab))
    if (auth.issuer !== ISSUER || auth.state !== 'signed_in')
      throw new QueryStopped('session_unverified')
    if (wc.isDestroyed() || tab.view.webContents !== wc || wc.getURL() !== initialUrl)
      throw new QueryStopped('navigation_changed')
  }
  try {
    await guard()
    const page = pageSchema.safeParse(
      await bounded(wc.executeJavaScript(pageScript('cancellation', range, 1, [], true), false))
    )
    await guard()
    if (!page.success) return { ok: false, issue: 'invalid_response' }
    if (!page.data.ok) return { ok: false, issue: page.data.issue }
    const streams: Partial<Record<Mode, StreamDiagnostic>> = {}
    const inspect = async (mode: Mode, supplied?: z.infer<typeof pageSchema>): Promise<void> => {
      const stream: StreamDiagnostic = { pages: [], decision: 'bounded_page_limit' }
      streams[mode] = stream
      let observed = 0
      let previousTotal: number | undefined
      let previousScope: string | undefined
      let cursors: string[] = []
      for (let number = 1; number <= 2; number++) {
        await guard()
        const parsed =
          supplied && number === 1
            ? { success: true as const, data: supplied }
            : pageSchema.safeParse(
                await bounded(
                  wc.executeJavaScript(pageScript(mode, range, number, cursors, true), false)
                )
              )
        await guard()
        if (!parsed.success) {
          stream.decision = 'invalid_response'
          return
        }
        const data = parsed.data
        if (data.diagnostic)
          stream.pages.push({
            ...data.diagnostic,
            page: number,
            observedRows: observed + (data.diagnostic.rowCount ?? 0)
          })
        if (!data.ok) {
          stream.decision = data.issue
          return
        }
        if (previousScope !== undefined && previousScope !== data.scope) {
          stream.decision = 'card_scope_changed'
          return
        }
        if (previousTotal !== undefined && data.total !== 0 && previousTotal !== data.total) {
          stream.decision = 'total_changed'
          return
        }
        previousScope = data.scope
        previousTotal ??= data.total
        const count = data.rowCount ?? data.rows.length
        observed += count
        if (observed > previousTotal) {
          stream.decision = 'count_exceeds_total'
          return
        }
        if (observed === previousTotal) {
          stream.decision = data.cursors.some(Boolean)
            ? 'terminal_cursor_remaining'
            : 'count_and_cursor_terminal'
          return
        }
        if (count !== PAGE_SIZE) {
          stream.decision = 'short_page_before_total'
          return
        }
        if (!data.cursors.some(Boolean)) {
          stream.decision = 'cursor_missing_before_total'
          return
        }
        if (number > 1 && data.cursors.every((value, i) => value === cursors[i])) {
          stream.decision = 'cursor_stalled'
          return
        }
        cursors = data.cursors
      }
    }
    await inspect('cancellation', page.data)
    await inspect('approval')
    await inspect('overseas_cancellation')
    // Fixed enum buckets only. Unknown values, card/approval IDs and even
    // arbitrary schema values are never used as histogram keys or returned.
    const partialFlags = {
      missing: 0,
      emptyString: 0,
      whitespace: 0,
      code0: 0,
      code1: 0,
      code2: 0,
      flagN: 0,
      flagY: 0,
      other: 0
    }
    const processingStates = {
      missing: 0,
      empty: 0,
      completedApproval: 0,
      completedPayment: 0,
      pending: 0,
      other: 0
    }
    for (const row of page.data.rows) {
      const partial = text(row.poCanDvC)
      if (row.poCanDvC === null) partialFlags.missing++
      else if (row.poCanDvC === '') partialFlags.emptyString++
      else if (typeof row.poCanDvC === 'string' && !partial) partialFlags.whitespace++
      else if (partial === '0') partialFlags.code0++
      else if (partial === '1') partialFlags.code1++
      else if (partial === '2') partialFlags.code2++
      else if (partial === 'N') partialFlags.flagN++
      else if (partial === 'Y') partialFlags.flagY++
      else partialFlags.other++
      const process = text(row.canProcsStsC)
      if (row.canProcsStsC === null) processingStates.missing++
      else if (!process) processingStates.empty++
      else if (process === '1') processingStates.completedApproval++
      else if (process === '2') processingStates.completedPayment++
      else if (process === '3') processingStates.pending++
      else processingStates.other++
    }
    const candidates = page.data.rows.filter(
      (row) => text(row.poCanDvC) === '1' && ['1', '2'].includes(text(row.canProcsStsC))
    )
    const eligible = candidates.filter(detailIdentityAvailable)
    const rawShape = {
      firstPageRows: page.data.rows.length,
      reportedTotal: page.data.total,
      partialFlags,
      processingStates,
      partialCandidates: candidates.length,
      detailIdentityCandidates: eligible.length,
      streams
    }
    const candidate = eligible[0]
    if (!candidate)
      return {
        ok: false,
        issue: candidates.length
          ? 'partial_detail_identity_unavailable'
          : 'no_partial_cancellation_row',
        ...rawShape
      }
    const detail = detailSchema.safeParse(
      await bounded(wc.executeJavaScript(detailScript(candidate), false))
    )
    await guard()
    if (!detail.success) return { ok: false, issue: 'invalid_response', ...rawShape }
    if (!detail.data.ok) return { ok: false, issue: detail.data.issue, ...rawShape }
    const stamps = new Set<string>()
    let duplicateTimestampRows = 0
    for (const event of detail.data.rows) {
      const stamp = text(event.aprPoCanDtm)
      if (stamps.has(stamp)) duplicateTimestampRows++
      stamps.add(stamp)
    }
    return {
      ok: true,
      ...rawShape,
      detailRows: detail.data.rows.length,
      validTimestampRows: detail.data.rows.filter((row) => detailEventDate(row.aprPoCanDtm)).length,
      validAmountRows: detail.data.rows.filter((row) => won(row.aprPoCanAm) !== null).length,
      duplicateTimestampRows,
      pagingFieldsPresent: detail.data.pagingFieldsPresent
    }
  } catch (error) {
    return { ok: false, issue: error instanceof QueryStopped ? error.issue : 'collector_error' }
  }
}

class QueryStopped extends Error {
  constructor(readonly issue: string) {
    super(issue)
  }
}

async function bounded<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new QueryStopped('request_timeout')), REQUEST_MS + 1000)
        abort = () => reject(new QueryStopped('aborted'))
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
  }
}

async function sessionPause(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const finish = (aborted = false): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (aborted) reject(new QueryStopped('aborted'))
      else resolve()
    }
    const abort = (): void => finish(true)
    const timer = setTimeout(finish, SESSION_POLL_MS)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

const collectSamsungWithMode = async (
  tab: Parameters<CardApiCollector>[0],
  suppliedRange: CardDateRange,
  options: NonNullable<Parameters<CardApiCollector>[2]> = {},
  cancellationOnly = false
): Promise<CardApiResult> => {
  const started = Date.now()
  const rows: CardApiRow[] = []
  const issues = new Set<string>()
  let pages = 0
  let approvalComplete = false
  let cancellationStreamComplete = false
  let overseasEmptyVerified = false
  let statusComplete = false
  let cancellationQueryComplete = false
  const approvalObservations: CardApiRow[] = []
  const cancellationObservations: CardApiRow[] = []
  const summaryAmounts = new Map<CardApiRow, number>()
  const cancellationMarkedApprovals = new Set<CardApiRow>()
  const range = validRange(suppliedRange)
  const result = (): CardApiResult => ({
    // Keep S51 privately for cross-checks, but emit each S12 snapshot only once.
    rows: cancellationOnly ? cancellationObservations : rows,
    receipt: {
      issuer: ISSUER,
      range: range || suppliedRange,
      pages,
      rowCount: cancellationOnly ? cancellationObservations.length : rows.length,
      complete: false,
      approvalComplete: cancellationOnly ? false : approvalComplete,
      cancellationComplete: false,
      statusComplete: cancellationOnly ? false : statusComplete,
      ...(cancellationOnly
        ? {
            cancellationQueryComplete,
            cancellationQueryBasis: 'original_approval_date' as const
          }
        : {}),
      issues: [
        ...issues,
        ...(cancellationOnly && !overseasEmptyVerified
          ? ['overseas_cancellation_scope_unverified']
          : [])
      ],
      elapsedMs: Date.now() - started
    }
  })
  if (!range) {
    issues.add('invalid_date_range')
    return result()
  }
  const maxPages = Math.min(300, Math.max(1, Math.floor(options.maxPages ?? 100)))
  if (!Number.isFinite(maxPages)) {
    issues.add('invalid_page_limit')
    return result()
  }
  const wc = tab.view.webContents
  let initialUrl = ''
  const assertContext = (): void => {
    if (options.signal?.aborted) throw new QueryStopped('aborted')
    if (Date.now() - started >= RUN_MS) throw new QueryStopped('run_time_limit')
    if (tab.view.webContents !== wc || wc.isDestroyed() || wc.getURL() !== initialUrl)
      throw new QueryStopped('navigation_changed')
  }
  const guard = async (): Promise<void> => {
    assertContext()
    let auth = await bounded(pageBridge.cardSession(tab), options.signal)
    assertContext()
    // A freshly restored history page may not have rendered its signed-in markers yet.
    // This bounded wait reads session markers only; an API response is never retried.
    if (pages === 0 && auth.issuer === ISSUER && auth.state === 'unknown') {
      const readiness = new AbortController()
      const signal = options.signal
        ? AbortSignal.any([options.signal, readiness.signal])
        : readiness.signal
      let contextChanged = false
      const interrupt = (): void => {
        contextChanged = true
        readiness.abort()
      }
      const navigate = (
        _event: unknown,
        _url: string,
        _inPlace: boolean,
        mainFrame: boolean
      ): void => {
        if (mainFrame) interrupt()
      }
      const timer = setTimeout(() => readiness.abort(), INITIAL_SESSION_WAIT_MS)
      const contextWatch = setInterval(() => {
        try {
          assertContext()
        } catch {
          interrupt()
        }
      }, SESSION_POLL_MS)
      wc.on('did-start-navigation', navigate)
      wc.on('destroyed', interrupt)
      try {
        while (auth.issuer === ISSUER && auth.state === 'unknown') {
          await sessionPause(signal)
          assertContext()
          auth = await bounded(pageBridge.cardSession(tab), signal)
          assertContext()
        }
      } catch (error) {
        assertContext()
        if (contextChanged) throw new QueryStopped('navigation_changed')
        if (readiness.signal.aborted) throw new QueryStopped('session_unverified')
        throw error
      } finally {
        clearTimeout(timer)
        clearInterval(contextWatch)
        readiness.abort()
        wc.removeListener('did-start-navigation', navigate)
        wc.removeListener('destroyed', interrupt)
      }
    }
    if (auth.issuer !== ISSUER || auth.state !== 'signed_in')
      throw new QueryStopped(auth.state === 'signed_out' ? 'signed_out' : 'session_unverified')
  }
  try {
    if (wc.isDestroyed() || !isHistoryUrl(wc.getURL())) throw new QueryStopped('not_history_page')
    initialUrl = wc.getURL()
    let scope: string | undefined
    const modes: Mode[] = cancellationOnly
      ? ['approval', 'cancellation', 'overseas_cancellation']
      : ['approval', 'cancellation']
    for (const mode of modes) {
      let streamVerified = true
      let total: number | undefined
      let observed = 0
      let cursors: string[] = []
      const cursorHistory = new Set<string>()
      const sourceIds = new Map<string, CardApiRow>()
      for (let page = 1; ; page++) {
        await guard()
        if (pages >= maxPages) throw new QueryStopped('page_limit')
        pages++
        const raw = await bounded(
          wc.executeJavaScript(pageScript(mode, range, page, cursors), false),
          options.signal
        )
        await guard()
        const parsed = pageSchema.safeParse(raw)
        if (!parsed.success) throw new QueryStopped('invalid_response')
        const data = parsed.data
        if (!data.ok) {
          if (data.issue === 'service_error') {
            if (data.serviceFailure) issues.add('service_error_' + data.serviceFailure)
            issues.add(
              mode === 'approval'
                ? 'service_error_approval_stream'
                : 'service_error_cancellation_stream'
            )
          }
          throw new QueryStopped(data.issue)
        }
        if (scope && data.scope !== scope) throw new QueryStopped('card_scope_changed')
        scope = data.scope
        // Official D0/D8/DB retain TOT_DLNG_CT only on PAGE_NO === 1,
        // then use that saved count for every subsequent "more" decision.
        // Later responses may carry zero instead of repeating the header.
        // A different positive count is still a conflicting query snapshot.
        if (total !== undefined && data.total !== 0 && total !== data.total)
          throw new QueryStopped('total_changed')
        total ??= data.total
        if (mode === 'overseas_cancellation') {
          if (data.rowCount === undefined || data.rows.length || data.cursors.length !== 4)
            throw new QueryStopped('invalid_response')
          if (data.rowCount > 0) issues.add('overseas_cancellation_rows_unverified')
          observed += data.rowCount
          if (observed > total) throw new QueryStopped('total_count_mismatch')
          if (observed === total) {
            if (data.cursors.some(Boolean))
              throw new QueryStopped('overseas_terminal_cursor_remaining')
            // Only a proved empty S13 scope can complete this path today. Its
            // spotDlngDt and currency/refund arithmetic differ from domestic S12.
            overseasEmptyVerified = total === 0
            break
          }
          if (data.rowCount !== PAGE_SIZE) throw new QueryStopped('total_count_mismatch')
          if (!data.cursors.some(Boolean)) throw new QueryStopped('missing_pagination_cursor')
          const key = digest(data.cursors)
          if (cursorHistory.has(key)) throw new QueryStopped('pagination_stalled')
          cursorHistory.add(key)
          cursors = data.cursors
          continue
        }
        if (data.rowCount !== undefined) throw new QueryStopped('invalid_response')
        if (mode === 'cancellation' && !cancellationOnly)
          issues.add('cancellation_query_basis_unverified')
        for (const item of data.rows) {
          const row = normalize(item, mode)
          if (!row) {
            issues.add('invalid_transaction_row')
            streamVerified = false
            continue
          }
          const day = row.approvedAt.slice(0, 10)
          if (mode === 'approval' && (day < range.from || day > range.to)) {
            issues.add('approval_outside_requested_range')
            streamVerified = false
            continue
          }
          if (mode === 'cancellation' && (day < range.from || day > range.to)) {
            row.needsReview.push('cancellation_approval_outside_requested_range')
            streamVerified = false
          }
          if (
            mode === 'cancellation' &&
            row.status === 'partially_cancelled' &&
            ['1', '2'].includes(text(item.canProcsStsC))
          ) {
            // Only code 1 exposes the official partial-cancellation popup.
            if (text(item.poCanDvC) !== '1' || !detailIdentityAvailable(item)) {
              row.needsReview.push('cancellation_detail_identity_unavailable')
            } else {
              await guard()
              if (pages >= maxPages) throw new QueryStopped('page_limit')
              pages++
              const detail = detailSchema.safeParse(
                await bounded(wc.executeJavaScript(detailScript(item), false), options.signal)
              )
              await guard()
              if (!detail.success) row.needsReview.push('cancellation_detail_invalid_response')
              else if (!detail.data.ok)
                row.needsReview.push('cancellation_detail_' + detail.data.issue)
              else applySingleDetail(row, item, detail.data)
            }
          }
          const prior = sourceIds.get(row.sourceId)
          if (prior) {
            // Do not silently deduplicate potentially distinct partial cancellation events.
            issues.add('duplicate_source_identity')
            streamVerified = false
            if (!prior.needsReview.includes('duplicate_source_identity'))
              prior.needsReview.push('duplicate_source_identity')
            row.needsReview.push('duplicate_source_identity')
          }
          sourceIds.set(row.sourceId, row)
          for (const review of row.needsReview) issues.add(review)
          rows.push(row)
          if (mode === 'approval') {
            approvalObservations.push(row)
            if (row.kind === 'cancellation') summaryAmounts.set(row, row.amount)
            else if (text(item.poCanDvC) || text(item.canRcpdt))
              cancellationMarkedApprovals.add(row)
          } else cancellationObservations.push(row)
        }
        observed += data.rows.length
        if (observed > total) throw new QueryStopped('total_count_mismatch')
        if (observed === total) {
          if (data.cursors.some(Boolean)) throw new QueryStopped('terminal_cursor_remaining')
          if (mode === 'approval') approvalComplete = streamVerified
          else cancellationStreamComplete = streamVerified
          break
        }
        if (data.rows.length !== PAGE_SIZE) throw new QueryStopped('total_count_mismatch')
        if (rows.length >= MAX_ROWS) throw new QueryStopped('row_limit')
        if (data.cursors.length !== (mode === 'approval' ? 9 : 7) || !data.cursors.some(Boolean))
          throw new QueryStopped('missing_pagination_cursor')
        const cursorKey = digest(data.cursors)
        if (cursorHistory.has(cursorKey)) throw new QueryStopped('pagination_stalled')
        cursorHistory.add(cursorKey)
        cursors = data.cursors
      }
    }
  } catch (error) {
    const issue = error instanceof QueryStopped ? error.issue : 'collector_error'
    issues.add(issue)
    if (/signed_out|auth|session|navigation|abort|card_scope_changed/.test(issue))
      approvalComplete = false
  }
  const sameApproval = (left: CardApiRow, right: CardApiRow): boolean =>
    !!left.cardKey &&
    !!left.approvalNumber &&
    left.cardKey === right.cardKey &&
    left.approvalNumber === right.approvalNumber &&
    left.approvedAt === right.approvedAt &&
    left.merchant === right.merchant
  // A completed S12 snapshot can establish a refund independently of unrelated
  // S51 markers. A contradictory observation of that same original still
  // invalidates the row's financial proof; it never becomes a ledger update.
  for (const row of cancellationObservations) {
    if (row.cancellationEvidence !== true) continue
    const originals = approvalObservations.filter(
      (approval) => !summaryAmounts.has(approval) && sameApproval(approval, row)
    )
    const summaries = [...summaryAmounts].filter(([summary]) => sameApproval(summary, row))
    if (
      originals.some((original) => original.amount !== row.amount) ||
      summaries.some(
        ([summary, amount]) =>
          amount !== row.cancellationAmount ||
          (!!summary.eventDate && summary.eventDate !== row.eventDate)
      )
    ) {
      row.needsReview.push('cancellation_cross_source_conflict')
      issues.add('cancellation_cross_source_conflict')
      row.cancellationAmount = null
      row.netAmount = null
      delete row.cancellationEvidence
      delete row.cancellationAmountType
      delete row.cancellationEventId
    }
  }
  // S51 negative rows are summaries, not extra refunds. A uniquely matched,
  // proved S12 snapshot can safely explain the summary without adding money.
  for (const row of rows) {
    if (
      !row.needsReview.includes('amount_basis_unverified') ||
      !row.cardKey ||
      !row.approvalNumber ||
      !row.eventDate
    )
      continue
    const matches = rows.filter(
      (candidate) =>
        candidate !== row &&
        candidate.cancellationEvidence === true &&
        candidate.needsReview.length === 0 &&
        candidate.cardKey === row.cardKey &&
        candidate.approvalNumber === row.approvalNumber &&
        candidate.approvedAt === row.approvedAt &&
        candidate.merchant === row.merchant &&
        candidate.eventDate === row.eventDate &&
        candidate.cancellationAmount === row.amount
    )
    if (matches.length !== 1) continue
    const verified = matches[0]
    row.kind = 'status'
    row.amount = verified.amount
    row.status = verified.status
    row.cancellationAmount = verified.cancellationAmount
    row.cancellationEvidence = true
    row.cancellationAmountType = 'cumulative'
    row.netAmount = verified.netAmount
    row.needsReview = row.needsReview.filter(
      (issue) =>
        ![
          'cancellation_amount_unverified',
          'cross_source_cancellation_match_required',
          'amount_basis_unverified'
        ].includes(issue)
    )
  }
  // Receipt diagnostics are based on final evidence rather than stale review
  // flags from a summary that was explained by the separate official service.
  for (const issue of [
    'cancellation_amount_unverified',
    'cross_source_cancellation_match_required',
    'amount_basis_unverified'
  ]) {
    if (!rows.some((row) => row.needsReview.includes(issue))) issues.delete(issue)
  }
  // Official M0 calls the fixed inputs "이용기간"; D8 sends the same inputs
  // to S12 and displays aprDt separately from canRcpdt. Original-date Excel
  // exports and a live late cancellation confirm that this is approval-scope
  // status coverage. It does not prove an event-date cancellation feed.
  statusComplete =
    approvalComplete &&
    cancellationStreamComplete &&
    rows.every((row) => row.needsReview.length === 0 && row.status !== 'unknown') &&
    cancellationObservations.every(
      (row) =>
        row.cancellationEvidence === true &&
        row.cancellationAmountType === 'cumulative' &&
        [...summaryAmounts].filter(
          ([summary, amount]) =>
            sameApproval(summary, row) &&
            amount === row.cancellationAmount &&
            summary.eventDate === row.eventDate
        ).length === 1 &&
        approvalObservations
          .filter((approval) => !summaryAmounts.has(approval) && sameApproval(approval, row))
          .every((approval) => approval.amount === row.amount)
    ) &&
    [...summaryAmounts].every(
      ([summary, amount]) =>
        cancellationObservations.filter(
          (row) =>
            sameApproval(summary, row) &&
            row.cancellationEvidence === true &&
            row.cancellationAmount === amount &&
            row.eventDate === summary.eventDate
        ).length === 1
    ) &&
    [...cancellationMarkedApprovals].every((approval) =>
      cancellationObservations.some(
        (row) => sameApproval(approval, row) && row.cancellationEvidence === true
      )
    )
  // This flag describes the canonical cancellation query's bounded coverage,
  // not the status of every unrelated S51 approval or the refund amount proof.
  // Pending/partial rows can be fully listed while their refunds remain held.
  const queryMetadataIssues = new Set([
    'stable_approval_identity_unavailable',
    'approval_time_unavailable',
    'card_last4_unavailable',
    'cancellation_approval_outside_requested_range',
    'cancellation_event_date_unavailable',
    'cancellation_status_unrecognized',
    'cancellation_partial_flag_unavailable',
    'cancellation_partial_flag_unrecognized'
  ])
  cancellationQueryComplete =
    cancellationStreamComplete &&
    overseasEmptyVerified &&
    cancellationObservations.every(
      (row) =>
        !!row.cardKey &&
        !!row.cardLast4 &&
        !!row.approvalNumber &&
        !!row.eventDate &&
        row.eventDate >= row.approvedAt.slice(0, 10) &&
        row.amount > 0 &&
        !row.needsReview.some((issue) => queryMetadataIssues.has(issue))
    )
  return result()
}

export const collectSamsungApi: CardApiCollector = (tab, range, options) =>
  collectSamsungWithMode(tab, range, options)

/** Original-date domestic snapshots plus an independently proved empty overseas
 * S13 scope. Foreign nonempty rows stay unproved and never use domestic arithmetic.
 * S51 remains private until a narrower official approval lookup is proved. */
export const collectSamsungCancellationApi: CardApiCollector = (tab, range, options) =>
  collectSamsungWithMode(tab, range, options, true)
