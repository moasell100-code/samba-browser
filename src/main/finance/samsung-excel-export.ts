import { z } from 'zod'
import type { Tab } from '../browser/tab-manager'
import { pageBridge } from '../browser/page-bridge'
import type { CardDateRange } from './card-api-types'
import { isCardDate } from './card-date-range'

const HISTORY_PATHS = [
  '/personal/card/activity/UHPPRP0801M0.jsp',
  '/personal/card/activity/UHPPRP0801D0.jsp'
]
const ENDPOINT = 'https://www.samsungcard.com/frontservice/exceldownload'
export const SAMSUNG_EXCEL_SCOPES = [
  'domestic',
  'domestic_cancellation',
  'overseas',
  'overseas_cancellation',
  'transport',
  'transport_tmoney',
  'hipass'
] as const
export type SamsungExcelScope = (typeof SAMSUNG_EXCEL_SCOPES)[number]
const SCOPE_CONTRACT = {
  domestic: {
    query: 'SHPPRP0801S51',
    export: 'SHPPRP0801S21',
    cursors: 9,
    fields: {
      strtAm: -99999999999,
      endAm: 99999999999,
      dtAry: '',
      amAry: '',
      cardUIzInqrDvC: 'Z',
      fpyIstmIz: { cardUMthDvC: '00', fpyIstmDvC: ' ' }
    }
  },
  domestic_cancellation: {
    query: 'SHPPRP0801S12',
    export: 'SHPPRP0801S32',
    cursors: 7,
    fields: { canDvC: '', cardUIzInqrDvC: 'H', domCanIz: { cardUMthDvC: '00', canDvC: '' } }
  },
  overseas: {
    query: 'SHPPRP0801S10',
    export: 'SHPPRP0801S30',
    cursors: 4,
    fields: { cardUIzInqrDvC: '1' }
  },
  overseas_cancellation: {
    query: 'SHPPRP0801S13',
    export: 'SHPPRP0801S33',
    cursors: 4,
    fields: { canDvC: '', cardUIzInqrDvC: '3' }
  },
  transport: {
    query: 'SHPPRP0801S06',
    export: 'SHPPRP0801S26',
    cursors: 5,
    fields: {
      uTrfcDvC: '0',
      cardUIzInqrDvC: 'D',
      afpymTrfcHips: { uTrfcDvC: '0', uTrfcStlmDvC: 'A' }
    }
  },
  transport_tmoney: {
    query: 'SHPPRP0801S06',
    export: 'SHPPRP0801S26',
    cursors: 5,
    fields: {
      uTrfcDvC: 'Z',
      cardUIzInqrDvC: 'D',
      afpymTrfcHips: { uTrfcDvC: 'Z', uTrfcStlmDvC: 'M' }
    }
  },
  hipass: {
    query: 'SHPPRP0801S07',
    export: 'SHPPRP0801S26',
    cursors: 5,
    fields: {
      uTrfcDvC: '5',
      cardUIzInqrDvC: 'E',
      afpymTrfcHips: { uTrfcDvC: '5', uTrfcStlmDvC: 'T' }
    }
  }
} as const
const MAX_BYTES = 25 * 1024 * 1024
const MAX_ROWS = 100_000
const MAX_PAYLOAD = 32_000
const planSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      expectedRows: z.number().int().min(0).max(MAX_ROWS),
      payload: z.string().min(2).max(MAX_PAYLOAD)
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      issue: z.enum([
        'history_page_required',
        'page_not_ready',
        'card_scope_not_all',
        'query_failed',
        'query_timeout',
        'invalid_response',
        'export_plan_unavailable',
        'navigation_changed'
      ])
    })
    .strict()
])

/** Private result: persist the bytes locally; never return them, payloads or file names to an LLM. */
export interface SamsungExcelExport {
  issuer: 'samsung_card'
  range: CardDateRange
  scope: SamsungExcelScope
  service: (typeof SCOPE_CONTRACT)[SamsungExcelScope]['export']
  bytes: Buffer
  extension: 'xls' | 'xlsx'
  expectedRows: number
}

function isHistoryUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.origin === 'https://www.samsungcard.com' &&
      !url.username &&
      !url.password &&
      HISTORY_PATHS.includes(url.pathname)
    )
  } catch {
    return false
  }
}

function validRange(range: CardDateRange): boolean {
  return (
    isCardDate(range.from) &&
    isCardDate(range.to) &&
    range.from <= range.to &&
    range.from.slice(0, 7) === range.to.slice(0, 7)
  )
}

/**
 * Public UHPPRP0801D0/D4/D5/D8/D9/DB.js provide these fixed query/export pairs.
 * Public scard.common.dc.js: buildAjaxSettings supplies the native common envelope;
 * executeExcelDownload POSTs payload/serviceId/extention/separator/charset to this fixed endpoint.
 * Fresh filters avoid reusing a screen's amounts, selected card or pagination cursors.
 */
function planScript(range: CardDateRange, scope: SamsungExcelScope): string {
  return `(async () => {
    const input = ${JSON.stringify({ from: range.from.replaceAll('-', ''), to: range.to.replaceAll('-', '') })};
    const contract = ${JSON.stringify(SCOPE_CONTRACT[scope])};
    const fail = issue => ({ok:false,issue});
    const url = new URL(location.href);
    if(url.origin !== 'https://www.samsungcard.com' || url.username || url.password || !${JSON.stringify(HISTORY_PATHS)}.includes(url.pathname)) return fail('history_page_required');
    if(typeof scard !== 'object' || typeof scard.ajax !== 'function' || typeof scard.buildAjaxSettings !== 'function' || typeof ENV !== 'object' || !ENV.CONDITION) return fail('page_not_ready');
    const data = {};
    for(const key of ['cardDvC','cardKndC','isCstMngtNo','pssCstMngtNo','cardCntrNo']) {
      const value = ENV.CONDITION[key];
      if((typeof value !== 'string' && typeof value !== 'number') || String(value).length > 100) return fail('page_not_ready');
      data[key] = value;
    }
    if(String(data.pssCstMngtNo).trim() !== '0' || String(data.cardCntrNo).trim() !== '0') return fail('card_scope_not_all');
    Object.assign(data, {inqrStrtdt:input.from,inqrEnddt:input.to,no1PgeSize:10}, contract.fields);
    for(let n=1;n<=contract.cursors;n++) data['no'+n+'NextKeyCn']='';
    return await new Promise(resolve => {
      let settled=false;
      const finish=value=>{if(!settled){settled=true;clearTimeout(timer);resolve(value)}};
      const timer=setTimeout(()=>finish(fail('query_timeout')),15000);
      try {
        scard.ajax({service:contract.query,data:JSON.parse(JSON.stringify(data)),timeout:15000,
          success:response=>{
            try {
              if(location.href !== url.href) return finish(fail('navigation_changed'));
              if(!response || typeof response !== 'object' || response.common && String(response.common.procsRsDvC) !== '0') return finish(fail('query_failed'));
              const count=String(response.totDlngCt ?? '');
              if(!/^\\d+$/.test(count) || !Number.isSafeInteger(Number(count)) || Number(count)>${MAX_ROWS}) return finish(fail('invalid_response'));
              const settings=scard.buildAjaxSettings({service:contract.export,data:{...data,prtgPrvwYn:'Y'},excel:true});
              if(!settings || settings.service !== contract.export || typeof settings.data !== 'string' || settings.data.length > ${MAX_PAYLOAD}) return finish(fail('export_plan_unavailable'));
              finish({ok:true,expectedRows:Number(count),payload:settings.data});
            } catch { finish(fail('export_plan_unavailable')); }
          },error:()=>finish(fail('query_failed'))});
      } catch { finish(fail('query_failed')); }
    });
  })()`
}

const SAFE_ERRORS = new Set([
  'invalid_export_range',
  'history_page_required',
  'authentication_required',
  'navigation_changed',
  'page_not_ready',
  'card_scope_not_all',
  'query_failed',
  'query_timeout',
  'invalid_response',
  'export_plan_unavailable',
  'export_response_unavailable',
  'export_response_limit',
  'export_file_unrecognized',
  'export_timeout',
  'export_cancelled'
])

function checkPayload(payload: string, range: CardDateRange, scope: SamsungExcelScope): boolean {
  try {
    const data = JSON.parse(payload)
    const contract = SCOPE_CONTRACT[scope]
    return (
      data &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      data.inqrStrtdt === range.from.replaceAll('-', '') &&
      data.inqrEnddt === range.to.replaceAll('-', '') &&
      String(data.pssCstMngtNo).trim() === '0' &&
      String(data.cardCntrNo).trim() === '0' &&
      data.prtgPrvwYn === 'Y' &&
      data.no1PgeSize === 10 &&
      Object.entries(contract.fields).every(
        ([key, value]) => JSON.stringify(data[key]) === JSON.stringify(value)
      ) &&
      Array.from({ length: contract.cursors }, (_, n) => data['no' + (n + 1) + 'NextKeyCn']).every(
        (value) => value === ''
      )
    )
  } catch {
    return false
  }
}

export async function exportSamsungWorkbook(
  tab: Tab,
  range: CardDateRange,
  options: { signal?: AbortSignal; scope?: SamsungExcelScope } = {}
): Promise<SamsungExcelExport> {
  if (!validRange(range)) throw new Error('invalid_export_range')
  const scope = options.scope ?? 'domestic'
  if (!(SAMSUNG_EXCEL_SCOPES as readonly string[]).includes(scope))
    throw new Error('invalid_export_scope')
  const service = SCOPE_CONTRACT[scope].export
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  timer.unref?.()
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal
  const wc = tab.view.webContents
  const url = wc.getURL()
  const context = (): void => {
    if (options.signal?.aborted) throw new Error('export_cancelled')
    if (controller.signal.aborted) throw new Error('export_timeout')
    if (wc.isDestroyed() || tab.view.webContents !== wc || wc.getURL() !== url)
      throw new Error('navigation_changed')
  }
  const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    context()
    let onAbort: (() => void) | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          onAbort = () =>
            reject(new Error(options.signal?.aborted ? 'export_cancelled' : 'export_timeout'))
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
        })
      ])
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }
  try {
    if (!isHistoryUrl(url)) throw new Error('history_page_required')
    const auth = await bounded(pageBridge.cardSession(tab))
    context()
    if (auth.issuer !== 'samsung_card' || auth.state !== 'signed_in')
      throw new Error('authentication_required')
    const parsed = planSchema.safeParse(
      await bounded(wc.executeJavaScript(planScript(range, scope), false))
    )
    context()
    if (!parsed.success) throw new Error('export_plan_unavailable')
    if (!parsed.data.ok) throw new Error(parsed.data.issue)
    if (!checkPayload(parsed.data.payload, range, scope)) throw new Error('export_plan_unavailable')
    const expectedRows = parsed.data.expectedRows
    if (expectedRows === 0) {
      const finalAuth = await bounded(pageBridge.cardSession(tab))
      context()
      if (finalAuth.issuer !== 'samsung_card' || finalAuth.state !== 'signed_in')
        throw new Error('authentication_required')
      return {
        issuer: 'samsung_card',
        range: { ...range },
        scope,
        service,
        bytes: Buffer.alloc(0),
        extension: 'xls',
        expectedRows: 0
      }
    }
    const body = new URLSearchParams({
      payload: parsed.data.payload,
      serviceId: service,
      extention: '',
      separator: '',
      charset: ''
    })
    const response = await bounded(
      wc.session.fetch(ENDPOINT, {
        method: 'POST',
        credentials: 'include',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Referer: url
        },
        body: body.toString(),
        signal
      })
    )
    context()
    if (!response.ok || (response.url && response.url !== ENDPOINT) || !response.body)
      throw new Error('export_response_unavailable')
    const length = response.headers.get('content-length')
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))
      throw new Error('export_response_limit')
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let size = 0
    try {
      for (;;) {
        const chunk = await bounded(reader.read())
        context()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > MAX_BYTES) throw new Error('export_response_limit')
        chunks.push(Buffer.from(chunk.value))
      }
    } finally {
      void reader.cancel().catch(() => undefined)
    }
    const bytes = Buffer.concat(chunks)
    const zip = bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    const ole = bytes
      .subarray(0, 8)
      .equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
    const type = response.headers.get('content-type')?.toLowerCase() ?? ''
    const attachment = /\battachment\b/i.test(response.headers.get('content-disposition') ?? '')
    const htmlExcel =
      (attachment || /excel|spreadsheet/.test(type)) &&
      /<(?:html|table|Workbook)\b/i.test(bytes.subarray(0, 8192).toString('utf8'))
    if (!bytes.length || (!zip && !ole && !htmlExcel)) throw new Error('export_file_unrecognized')
    const finalAuth = await bounded(pageBridge.cardSession(tab))
    context()
    if (finalAuth.issuer !== 'samsung_card' || finalAuth.state !== 'signed_in')
      throw new Error('authentication_required')
    return {
      issuer: 'samsung_card',
      range: { ...range },
      scope,
      service,
      bytes,
      extension: zip ? 'xlsx' : 'xls',
      expectedRows
    }
  } catch (error) {
    if (options.signal?.aborted) throw new Error('export_cancelled')
    if (controller.signal.aborted) throw new Error('export_timeout')
    throw new Error(
      error instanceof Error && SAFE_ERRORS.has(error.message)
        ? error.message
        : 'export_response_unavailable'
    )
  } finally {
    clearTimeout(timer)
  }
}
