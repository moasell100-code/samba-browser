import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { Tab } from '../browser/tab-manager'
import { pageBridge } from '../browser/page-bridge'
import type { CardDateRange } from './card-api-types'
import { dailyCardRanges, recentCardDateRange } from './card-date-range'

const REQUEST_MS = 15_000
const RUN_MS = 120_000
const PAGE_SIZE = 10
const MAX_PAGES = 30
const MAX_TOTAL = 10_000
const scopes = ['domestic', 'overseas'] as const
type Scope = (typeof scopes)[number]
const count = z.number().int().min(0).max(100_000)
const dateCounts = z
  .object({ inside: count, outside: count, missing: count, invalid: count })
  .strict()
const mainStates = z
  .object({
    code1: count,
    code2: count,
    code3: count,
    code4: count,
    code5: count,
    code6: count,
    code7: count,
    missing: count,
    empty: count,
    other: count
  })
  .strict()
const detailStates = z
  .object({
    code1: count,
    code2: count,
    code3: count,
    code4: count,
    code5: count,
    missing: count,
    empty: count,
    other: count
  })
  .strict()
const statistics = z
  .object({
    rows: count,
    detailRows: count,
    saleDate: dateCounts,
    cancellationReceivedDate: dateCounts,
    processingDate: dateCounts,
    mainStates,
    detailStates,
    detailJoins: z
      .object({
        matched: count,
        unmatched: count,
        ambiguous: count,
        missing: count,
        expectedCountMissing: count,
        expectedCountMismatch: count
      })
      .strict()
  })
  .strict()
type Statistics = z.infer<typeof statistics>
const issueCodes = [
  'invalid_range',
  'not_history_page',
  'page_not_ready',
  'card_scope_not_all',
  'session_unverified',
  'navigation_changed',
  'aborted',
  'request_timeout',
  'run_time_limit',
  'invalid_response',
  'service_error',
  'card_scope_changed',
  'total_changed',
  'count_overflow',
  'short_page',
  'cursor_missing',
  'cursor_repeated',
  'terminal_cursor_remaining',
  'duplicate_rows',
  'page_limit',
  'diagnostic_unavailable'
] as const
type Issue = (typeof issueCodes)[number]
const pageSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      total: z.number().int().min(0).max(MAX_TOTAL),
      statistics,
      cursors: z.array(z.string().max(4000)).length(2),
      scopeDigest: z.string().regex(/^[a-f0-9]{64}$/)
    })
    .strict(),
  z
    .object({ ok: z.literal(false), issue: z.enum(issueCodes), duplicateRows: count.optional() })
    .strict()
])

function blankStatistics(): Statistics {
  const dates = (): Statistics['saleDate'] => ({ inside: 0, outside: 0, missing: 0, invalid: 0 })
  return {
    rows: 0,
    detailRows: 0,
    saleDate: dates(),
    cancellationReceivedDate: dates(),
    processingDate: dates(),
    mainStates: {
      code1: 0,
      code2: 0,
      code3: 0,
      code4: 0,
      code5: 0,
      code6: 0,
      code7: 0,
      missing: 0,
      empty: 0,
      other: 0
    },
    detailStates: {
      code1: 0,
      code2: 0,
      code3: 0,
      code4: 0,
      code5: 0,
      missing: 0,
      empty: 0,
      other: 0
    },
    detailJoins: {
      matched: 0,
      unmatched: 0,
      ambiguous: 0,
      missing: 0,
      expectedCountMissing: 0,
      expectedCountMismatch: 0
    }
  }
}

export interface SamsungCancelDateScopeDiagnostic {
  scope: Scope
  pages: number
  reportedTotal: number | null
  termination: 'count_exhausted' | 'stopped'
  terminalCursorPresent: boolean
  issue?: Issue
  duplicateRows?: number
  statistics: Statistics
}
export interface SamsungCancelDateDiagnostic {
  state: 'ready' | 'partial' | 'unavailable' | 'invalid_range'
  dateBasis: 'unverified'
  originalPaymentDate: 'not_in_public_contract'
  scopes: SamsungCancelDateScopeDiagnostic[]
  issue?: Issue
}

function historyUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      !url.username &&
      !url.password &&
      url.origin === 'https://www.samsungcard.com' &&
      [
        '/personal/card/activity/UHPPRP0801M0.jsp',
        '/personal/card/activity/UHPPRP0801D0.jsp',
        '/personal/card/activity/UHPPRP0801D8.jsp'
      ].includes(url.pathname)
    )
  } catch {
    return false
  }
}

/** Public DF.js S43 contract only. Raw rows are reduced inside the renderer.
 * Opaque next-page cursors and a scope digest are ephemeral transport controls;
 * neither is exposed in the diagnostic receipt or written to disk.
 */
function pageScript(
  scope: Scope,
  range: CardDateRange,
  page: number,
  cursors: string[],
  runKey: string
): string {
  const input = JSON.stringify({
    scope,
    from: range.from.replaceAll('-', ''),
    to: range.to.replaceAll('-', ''),
    page,
    cursors,
    runKey
  })
  return `(async () => {
    const input = ${input};
    const fail = issue => ({ok:false, issue});
    const url = new URL(location.href);
    if (url.origin !== 'https://www.samsungcard.com' || url.username || url.password || !['/personal/card/activity/UHPPRP0801M0.jsp','/personal/card/activity/UHPPRP0801D0.jsp','/personal/card/activity/UHPPRP0801D8.jsp'].includes(url.pathname)) return fail('not_history_page');
    if (typeof scard !== 'object' || typeof scard.ajax !== 'function' || typeof ENV !== 'object' || !ENV.CONDITION) return fail('page_not_ready');
    const scalar = value => {
      if (value == null) return null;
      if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'number' && !Number.isFinite(value)) || String(value).length > 200) throw new Error();
      return String(value).trim();
    };
    const keys = ['cardDvC','cardKndC','isCstMngtNo','pssCstMngtNo','cardCntrNo'];
    const data = {};
    for (const key of keys) {
      const value = ENV.CONDITION[key];
      if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim() || String(value).length > 100 || (typeof value === 'number' && !Number.isFinite(value))) return fail('page_not_ready');
      data[key] = value;
    }
    if (String(data.cardCntrNo).trim() !== '0' || String(data.pssCstMngtNo).trim() !== '0') return fail('card_scope_not_all');
    const scopeSnapshot = JSON.stringify(keys.map(key => String(data[key])));
    const unchanged = () => location.href === url.href && JSON.stringify(keys.map(key => String(ENV.CONDITION[key]))) === scopeSnapshot;
    // One ephemeral renderer-private run record keeps account and row keys out
    // of main. No asynchronous work may precede the fixed ajax invocation.
    const gateKey=Symbol.for('jaja.samsung.cancelDateProbe.'+input.runKey);
    let gate=window[gateKey];
    if (!gate) {
      if (input.scope!=='domestic' || input.page!==1) return fail('card_scope_changed');
      Object.defineProperty(window,gateKey,{configurable:true,value:{scopeSnapshot,seen:{domestic:new Set(),overseas:new Set()}}});
      gate=window[gateKey];
    }
    if (gate.scopeSnapshot!==scopeSnapshot) return fail('card_scope_changed');
    const scopeDigest=input.runKey.replaceAll('-','').padEnd(64,'0');
    if (!unchanged()) return fail('card_scope_changed');
    Object.assign(data, {inqrStrtdt:input.from, inqrEnddt:input.to, inqrDvC:'0', slOcDvC:input.scope === 'domestic' ? '1' : '2', no1PgeSize:${PAGE_SIZE}, no1NextKeyCn:input.cursors[0] || '', no2NextKeyCn:input.cursors[1] || ''});
    if (input.page > 1) Object.assign(data,{pgeNo:input.page,prtgPrvwYn:''});
    return await new Promise(resolve => {
      let settled = false;
      const finish = value => { if (!settled) {settled=true;clearTimeout(timer);resolve(value);} };
      const timer = setTimeout(() => finish(fail('request_timeout')),${REQUEST_MS});
      try { scard.ajax({service:'SHPPRP0801S43',data,timeout:${REQUEST_MS},success:response => {
        try {
          if (!unchanged()) return finish(fail('card_scope_changed'));
          if (!response || typeof response !== 'object' || !response.common || String(response.common.procsRsDvC) !== '0') return finish(fail('service_error'));
          const totalText = scalar(response.totDlngCt);
          if (!totalText || !/^\\d+$/.test(totalText) || Number(totalText)>${MAX_TOTAL}) return finish(fail('invalid_response'));
          const total = Number(totalText);
          const main = response.hppRPStlmCanIzSub01SVO == null && total === 0 ? [] : response.hppRPStlmCanIzSub01SVO;
          const detail = response.hppRPStlmCanIzSub02SVO == null ? [] : response.hppRPStlmCanIzSub02SVO;
          if (!Array.isArray(main) || main.length>${PAGE_SIZE} || !Array.isArray(detail) || detail.length>1000) return finish(fail('invalid_response'));
          const stats = ${JSON.stringify(blankStatistics())};
          const object = row => row && typeof row === 'object' && !Array.isArray(row);
          const dates = (value,bucket) => {
            const text = scalar(value);
            if (!text) { bucket.missing++; return; }
            const compact = text.replace(/[.\\/-]/g,'');
            if (!/^\\d{8}$/.test(compact)) { bucket.invalid++;return; }
            const iso=compact.slice(0,4)+'-'+compact.slice(4,6)+'-'+compact.slice(6,8);
            const parsed=new Date(iso+'T00:00:00Z');
            if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10)!==iso) { bucket.invalid++;return; }
            bucket[compact>=input.from && compact<=input.to ? 'inside' : 'outside']++;
          };
          const state = (value,bucket,max) => {
            const text=scalar(value);
            if (text===null) bucket.missing++;
            else if (!text) bucket.empty++;
            else if (/^[1-7]$/.test(text) && Number(text)<=max) bucket['code'+text]++;
            else bucket.other++;
          };
          const join = row => {
            const key=scalar(row.slMngtNo), day=scalar(row.slRcpdt);
            return key && day ? JSON.stringify([key,day]) : null;
          };
          const parents = new Map();
          let duplicateRows=0;
          for (const row of main) {
            if (!object(row)) throw new Error();
            stats.rows++;
            dates(row.slDt,stats.saleDate); dates(row.slRcpdt,stats.cancellationReceivedDate);
            state(row.canProcsRsC,stats.mainStates,7);
            const key=join(row);
            if (key) {
              if (gate.seen[input.scope].has(key)) duplicateRows++;
              gate.seen[input.scope].add(key);
              parents.set(key,(parents.get(key)||0)+1);
            }
          }
          if (duplicateRows) return finish({ok:false,issue:'duplicate_rows',duplicateRows});
          const matched = new Map();
          for (const row of detail) {
            if (!object(row)) throw new Error();
            stats.detailRows++;
            dates(row.canPrcsdt,stats.processingDate);
            state(row.poCanProcsRsC,stats.detailStates,5);
            const key=join(row), matches=key ? parents.get(key)||0 : 0;
            if (!key) stats.detailJoins.missing++;
            else if (!matches) stats.detailJoins.unmatched++;
            else if (matches>1) stats.detailJoins.ambiguous++;
            else { stats.detailJoins.matched++; matched.set(key,(matched.get(key)||0)+1); }
          }
          for (const row of main) {
            const expected=scalar(row.procsCt), key=join(row);
            if (!expected || !/^\\d+$/.test(expected) || Number(expected)>1000) stats.detailJoins.expectedCountMissing++;
            else if (!key || parents.get(key)!==1 || (matched.get(key)||0)!==Number(expected)) stats.detailJoins.expectedCountMismatch++;
          }
          const cursors=[];
          for (let n=1;n<=2;n++) {
            const value=response['no'+n+'NextKeyCn']??'';
            if (typeof value!=='string' || value.length>4000) throw new Error();
            cursors.push(value);
          }
          finish({ok:true,total,statistics:stats,cursors,scopeDigest});
        } catch {finish(fail('invalid_response'));}
      },error:() => finish(fail('service_error'))}); } catch { finish(fail('service_error')); }
    });
  })()`
}

class ProbeStopped extends Error {
  constructor(readonly issue: Issue) {
    super(issue)
  }
}

/** Two fixed S43 scopes; counts certify pagination only, never cancellation coverage or amounts. */
export async function probeSamsungCancelDate(
  tab: Tab,
  range: CardDateRange,
  suppliedSignal?: AbortSignal
): Promise<SamsungCancelDateDiagnostic> {
  const output: SamsungCancelDateDiagnostic = {
    state: 'unavailable',
    dateBasis: 'unverified',
    originalPaymentDate: 'not_in_public_contract',
    scopes: []
  }
  try {
    dailyCardRanges(range)
    if (range.from < '2026-07-01' || range.to > recentCardDateRange().to) throw new Error()
  } catch {
    return { ...output, state: 'invalid_range', issue: 'invalid_range' }
  }
  const wc = tab.view.webContents
  const url = wc.getURL()
  if (wc.isDestroyed() || !historyUrl(url)) return { ...output, issue: 'not_history_page' }
  const controller = new AbortController()
  const runKey = randomUUID()
  let stopped: Issue = 'aborted'
  const stop = (issue: Issue): void => {
    stopped = issue
    controller.abort()
  }
  const externalAbort = (): void => stop('aborted')
  const destroyed = (): void => stop('navigation_changed')
  const navigate = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean): void => {
    if (mainFrame) stop('navigation_changed')
  }
  const timer = setTimeout(() => stop('run_time_limit'), RUN_MS)
  wc.on('did-start-navigation', navigate)
  wc.on('destroyed', destroyed)
  suppliedSignal?.addEventListener('abort', externalAbort, { once: true })
  if (suppliedSignal?.aborted) externalAbort()
  const context = (): void => {
    if (controller.signal.aborted) throw new ProbeStopped(stopped)
    if (wc.isDestroyed() || tab.view.webContents !== wc || wc.getURL() !== url)
      throw new ProbeStopped('navigation_changed')
  }
  const bounded = async <T>(pending: Promise<T>): Promise<T> => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new ProbeStopped('request_timeout')), REQUEST_MS + 1000)
          abort = () => reject(new ProbeStopped(stopped))
          if (controller.signal.aborted) abort()
          else controller.signal.addEventListener('abort', abort, { once: true })
        })
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
      if (abort) controller.signal.removeEventListener('abort', abort)
    }
  }
  const guard = async (): Promise<void> => {
    context()
    const auth = await bounded(pageBridge.cardSession(tab))
    context()
    if (auth.issuer !== 'samsung_card' || auth.state !== 'signed_in')
      throw new ProbeStopped('session_unverified')
  }
  try {
    let scopeDigest: string | undefined
    for (const scope of scopes) {
      const receipt: SamsungCancelDateScopeDiagnostic = {
        scope,
        pages: 0,
        reportedTotal: null,
        termination: 'stopped',
        terminalCursorPresent: false,
        statistics: blankStatistics()
      }
      output.scopes.push(receipt)
      let cursors: string[] = []
      const cursorHistory = new Set<string>()
      try {
        for (let page = 1; page <= MAX_PAGES; page++) {
          await guard()
          receipt.pages++
          const response = await bounded(
            wc.executeJavaScript(pageScript(scope, range, page, cursors, runKey), false)
          )
          await guard()
          const parsed = pageSchema.safeParse(response)
          if (!parsed.success) throw new ProbeStopped('invalid_response')
          const value = parsed.data
          if (!value.ok) {
            if (value.duplicateRows !== undefined) receipt.duplicateRows = value.duplicateRows
            throw new ProbeStopped(value.issue)
          }
          if (scopeDigest && value.scopeDigest !== scopeDigest)
            throw new ProbeStopped('card_scope_changed')
          scopeDigest = value.scopeDigest
          if (receipt.reportedTotal !== null && receipt.reportedTotal !== value.total)
            throw new ProbeStopped('total_changed')
          receipt.reportedTotal = value.total
          if (receipt.statistics.rows + value.statistics.rows > value.total)
            throw new ProbeStopped('count_overflow')
          for (const key of Object.keys(value.statistics) as Array<keyof Statistics>) {
            const added = value.statistics[key]
            if (typeof added === 'number') (receipt.statistics[key] as number) += added
            else
              for (const field of Object.keys(added)) {
                const target = receipt.statistics[key] as Record<string, number>
                target[field] += (added as Record<string, number>)[field]
              }
          }
          receipt.terminalCursorPresent = value.cursors.some(Boolean)
          if (receipt.statistics.rows === value.total) {
            if (receipt.terminalCursorPresent) throw new ProbeStopped('terminal_cursor_remaining')
            receipt.termination = 'count_exhausted'
            break
          }
          if (value.statistics.rows !== PAGE_SIZE) throw new ProbeStopped('short_page')
          if (!receipt.terminalCursorPresent) throw new ProbeStopped('cursor_missing')
          const cursorKey = JSON.stringify(value.cursors)
          if (cursorHistory.has(cursorKey)) throw new ProbeStopped('cursor_repeated')
          cursorHistory.add(cursorKey)
          cursors = value.cursors
          if (page === MAX_PAGES) throw new ProbeStopped('page_limit')
        }
      } catch (error) {
        receipt.issue = error instanceof ProbeStopped ? error.issue : 'diagnostic_unavailable'
        if (
          [
            'aborted',
            'navigation_changed',
            'session_unverified',
            'card_scope_changed',
            'run_time_limit'
          ].includes(receipt.issue)
        )
          throw new ProbeStopped(receipt.issue)
      }
    }
    output.state = output.scopes.every((scope) => scope.termination === 'count_exhausted')
      ? 'ready'
      : 'partial'
  } catch (error) {
    output.issue = error instanceof ProbeStopped ? error.issue : 'diagnostic_unavailable'
    output.state = output.scopes.some((scope) => scope.pages > 0) ? 'partial' : 'unavailable'
  } finally {
    clearTimeout(timer)
    suppliedSignal?.removeEventListener('abort', externalAbort)
    wc.removeListener('did-start-navigation', navigate)
    wc.removeListener('destroyed', destroyed)
    controller.abort()
    // Remove only this ephemeral private diagnostic record, never issuer state.
    if (!wc.isDestroyed()) {
      try {
        await bounded(
          wc.executeJavaScript(
            `(() => { delete window[Symbol.for(${JSON.stringify('jaja.samsung.cancelDateProbe.' + runKey)})]; })()`,
            false
          )
        )
      } catch {
        /* document may already be gone */
      }
    }
  }
  return output
}
