import { createHash } from 'node:crypto'
import { z } from 'zod'
import { pageBridge } from '../browser/page-bridge'
import type { CardApiCollector, CardApiResult, CardApiRow, CardDateRange } from './card-api-types'

const ISSUER = 'samsung_card' as const
const HISTORY_PATH = '/personal/card/activity/UHPPRP0801M0.jsp'
const PAGE_SIZE = 10
const REQUEST_MS = 15_000
const RUN_MS = 120_000
const MAX_ROWS = 10_000
type Mode = 'approval' | 'cancellation'

const cell = z.union([z.string().max(2000), z.number().finite(), z.null()])
const rawRowSchema = z
  .object({
    aprDt: cell,
    aprT: cell,
    aprno: cell,
    aprAm: cell,
    mrcNm: cell,
    itgCdnoe: cell,
    canRcpdt: cell,
    poCanDvC: cell,
    canProcsStsC: cell
  })
  .strict()
type RawRow = z.infer<typeof rawRowSchema>
const pageSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      total: z.number().int().min(0).max(MAX_ROWS),
      rows: z.array(rawRowSchema).max(PAGE_SIZE),
      cursors: z.array(z.string().max(4000)).max(9),
      scope: z.string().regex(/^[a-f0-9]{64}$/)
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      issue: z.enum([
        'not_history_page',
        'page_not_ready',
        'card_scope_not_all',
        'request_timeout',
        'service_error',
        'invalid_response'
      ])
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

function normalize(raw: RawRow, mode: Mode): CardApiRow | null {
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
  const cardLast4 = /^\d{4}$/.test(tail) ? tail : undefined
  if (!cardLast4) review.push('card_last4_unavailable')
  const cancellation = mode === 'cancellation' || signedAmount < 0
  const canDateRaw = text(raw.canRcpdt)
  const eventDate = canDateRaw ? isoDate(canDateRaw) : null
  let status: CardApiRow['status'] = 'approved'
  if (cancellation) {
    review.push('cancellation_amount_unverified', 'cross_source_cancellation_match_required')
    if (mode === 'cancellation') review.push('cancellation_query_basis_unverified')
    else review.push('amount_basis_unverified')
    if (!eventDate) review.push('cancellation_event_date_unavailable')
    const process = text(raw.canProcsStsC)
    if (mode === 'cancellation' && process !== '1' && process !== '2') {
      status = 'unknown'
      review.push(process === '3' ? 'cancellation_pending' : 'cancellation_status_unrecognized')
    } else {
      status = ['1', '2'].includes(text(raw.poCanDvC)) ? 'partially_cancelled' : 'cancelled'
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
    ...(cardLast4 ? { cardLast4 } : {}),
    merchant,
    amount: Math.abs(signedAmount),
    currency: 'KRW',
    status,
    cancellationAmount: null,
    netAmount: cancellation ? null : signedAmount,
    needsReview: review
  }
}

/**
 * Fixed read-only services from official UHPPRP0801D0.js (S51) and D8.js (S12).
 * ENV is read without changing page filters. scard.ajax supplies its own session/common envelope.
 * Only whitelisted response fields cross to private main-process memory, never to an agent response.
 */
function pageScript(mode: Mode, range: CardDateRange, page: number, cursors: string[]): string {
  const input = JSON.stringify({
    mode,
    from: range.from.replaceAll('-', ''),
    to: range.to.replaceAll('-', ''),
    page,
    cursors
  })
  return `(async () => {
    const input = ${input};
    const fail = issue => ({ ok: false, issue });
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
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(scopeKeys.map(key => String(data[key])))));
    const scope = Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
    if (location.href !== url.href) return fail('not_history_page');
    Object.assign(data, { inqrStrtdt: input.from, inqrEnddt: input.to, no1PgeSize: ${PAGE_SIZE} });
    const approval = input.mode === 'approval';
    const cursorCount = approval ? 9 : 7;
    for (let n = 1; n <= cursorCount; n++) data['no' + n + 'NextKeyCn'] = input.cursors[n - 1] || '';
    if (input.page > 1) Object.assign(data, { pgeNo: input.page, prtgPrvwYn: '' });
    if (approval) Object.assign(data, { strtAm: -99999999999, endAm: 99999999999, dtAry: '', amAry: '', cardUIzInqrDvC: 'Z', fpyIstmIz: { cardUMthDvC: '00', fpyIstmDvC: ' ' } });
    else Object.assign(data, { canDvC: '', cardUIzInqrDvC: 'H', domCanIz: { cardUMthDvC: '00', canDvC: '' } });
    return await new Promise(resolve => {
      let settled = false;
      const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
      const timer = setTimeout(() => finish(fail('request_timeout')), ${REQUEST_MS});
      try {
        scard.ajax({
          service: approval ? 'SHPPRP0801S51' : 'SHPPRP0801S12',
          data,
          timeout: ${REQUEST_MS},
          success: response => {
            try {
              if (!response || typeof response !== 'object' || (response.common && String(response.common.procsRsDvC) !== '0')) return finish(fail('service_error'));
              const totalText = String(response.totDlngCt ?? '');
              if (!/^\\d+$/.test(totalText)) return finish(fail('invalid_response'));
              const total = Number(totalText);
              if (!Number.isSafeInteger(total) || total > ${MAX_ROWS}) return finish(fail('invalid_response'));
              const key = approval ? 'hppRPCardUIzSub01SVO' : 'hppRPDomCanIzSub01SVO';
              const source = response[key] == null && total === 0 ? [] : response[key];
              if (!Array.isArray(source) || source.length > ${PAGE_SIZE}) return finish(fail('invalid_response'));
              const fields = ['aprDt','aprT','aprno','aprAm','mrcNm','itgCdnoe','canRcpdt','poCanDvC','canProcsStsC'];
              const rows = source.map(row => {
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
              for (let n = 1; n <= cursorCount; n++) {
                const value = response['no' + n + 'NextKeyCn'] ?? '';
                if (typeof value !== 'string' || value.length > 4000) return finish(fail('invalid_response'));
                next.push(value);
              }
              finish({ ok: true, total, rows, cursors: next, scope });
            } catch { finish(fail('invalid_response')); }
          },
          error: () => finish(fail('service_error'))
        });
      } catch { finish(fail('service_error')); }
    });
  })()`
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

export const collectSamsungApi: CardApiCollector = async (tab, suppliedRange, options = {}) => {
  const started = Date.now()
  const rows: CardApiRow[] = []
  const issues = new Set<string>()
  let pages = 0
  const range = validRange(suppliedRange)
  const result = (): CardApiResult => ({
    rows,
    receipt: {
      issuer: ISSUER,
      range: range || suppliedRange,
      pages,
      rowCount: rows.length,
      complete: issues.size === 0,
      issues: [...issues],
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
  const guard = async (): Promise<void> => {
    if (options.signal?.aborted) throw new QueryStopped('aborted')
    if (Date.now() - started >= RUN_MS) throw new QueryStopped('run_time_limit')
    if (wc.isDestroyed() || wc.getURL() !== initialUrl) throw new QueryStopped('navigation_changed')
    const auth = await bounded(pageBridge.cardSession(tab), options.signal)
    if (wc.isDestroyed() || wc.getURL() !== initialUrl) throw new QueryStopped('navigation_changed')
    if (auth.issuer !== ISSUER || auth.state !== 'signed_in')
      throw new QueryStopped(auth.state === 'signed_out' ? 'signed_out' : 'session_unverified')
  }
  try {
    if (wc.isDestroyed() || !isHistoryUrl(wc.getURL())) throw new QueryStopped('not_history_page')
    initialUrl = wc.getURL()
    let scope: string | undefined
    for (const mode of ['approval', 'cancellation'] as const) {
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
        if (!data.ok) throw new QueryStopped(data.issue)
        if (scope && data.scope !== scope) throw new QueryStopped('card_scope_changed')
        scope = data.scope
        if (total !== undefined && total !== data.total) throw new QueryStopped('total_changed')
        total = data.total
        if (mode === 'cancellation') issues.add('cancellation_query_basis_unverified')
        for (const item of data.rows) {
          const row = normalize(item, mode)
          if (!row) {
            issues.add('invalid_transaction_row')
            continue
          }
          const day = row.approvedAt.slice(0, 10)
          if (mode === 'approval' && (day < range.from || day > range.to)) {
            issues.add('approval_outside_requested_range')
            continue
          }
          const prior = sourceIds.get(row.sourceId)
          if (prior) {
            // Do not silently deduplicate potentially distinct partial cancellation events.
            issues.add('duplicate_source_identity')
            if (!prior.needsReview.includes('duplicate_source_identity'))
              prior.needsReview.push('duplicate_source_identity')
            row.needsReview.push('duplicate_source_identity')
          }
          sourceIds.set(row.sourceId, row)
          for (const review of row.needsReview) issues.add(review)
          rows.push(row)
        }
        observed += data.rows.length
        if (observed > total) throw new QueryStopped('total_count_mismatch')
        if (observed === total) break
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
    issues.add(error instanceof QueryStopped ? error.issue : 'collector_error')
  }
  return result()
}
