import { pageBridge } from '../browser/page-bridge'
import type { Tab } from '../browser/tab-manager'
import type { CardDateRange } from './card-api-types'
import { isCardDate } from './card-date-range'

const HISTORY = 'https://www.lottecard.co.kr/app/LPMCDAA_V100.lc'
const ENDPOINT = 'https://www.lottecard.co.kr/app/LPMCDAA_V101.lc'
const SERVICE = 'LPMCDAA_V101' as const
const MAX_BYTES = 16 * 1024 * 1024
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
const SAFE_ERRORS = new Set([
  'invalid_export_range',
  'history_page_required',
  'authentication_required',
  'navigation_changed',
  'export_plan_unavailable',
  'export_response_unavailable',
  'export_response_limit',
  'export_file_unrecognized',
  'export_timeout',
  'export_cancelled'
])

/** Main-process-only bytes. The caller persists these; never expose workbook contents through MCP. */
export interface LotteExcelExport {
  issuer: 'lotte_card'
  range: CardDateRange
  service: typeof SERVICE
  bytes: Buffer
  extension: 'xls' | 'xlsx'
  expectedRows: null
}

function historyUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return !url.username && !url.password && url.origin + url.pathname === HISTORY
  } catch {
    return false
  }
}

function validRange(range: CardDateRange): boolean {
  return (
    isCardDate(range.from) &&
    isCardDate(range.to) &&
    range.from <= range.to &&
    Date.parse(range.to) - Date.parse(range.from) <= 30 * 86_400_000
  )
}

/**
 * Verified fnSaveExcel -> fnSetFormData -> svcf_Submit posts this 15-field form to V101.
 * The issuer's public eiwaf helper defaults to POST. Reproduce its all-card/filter semantics
 * in a private copy, without submitting or mutating the live history page.
 */
function planScript(range: CardDateRange): string {
  return `(() => {
    const url = new URL(location.href);
    if (url.origin + url.pathname !== '${HISTORY}' || url.username || url.password) return null;
    const forms = [...document.querySelectorAll('form[name="LPMCDAAAprUseList"]')];
    if (forms.length !== 1) return null;
    const fields = [...forms[0].elements];
    const names = ${JSON.stringify(FIELDS)};
    if (fields.length !== names.length || fields.some(field => field.tagName !== 'INPUT' || field.type !== 'hidden' || field.disabled || !names.includes(field.name))) return null;
    const data = {};
    for (const name of names) {
      const matched = fields.filter(field => field.name === name);
      if (matched.length !== 1 || typeof matched[0].value !== 'string' || matched[0].value.length > (name === 'nextKey' ? 8192 : name === 'encCdno' ? 2048 : 128)) return null;
      data[name] = matched[0].value;
    }
    if (document.querySelectorAll('input[type="checkbox"]#useCarditemAll').length !== 1) return null;
    for (const name of ['useCdDv','uplDv','useDv','stDv']) {
      const matched = [...document.querySelectorAll('input[type="radio"]')]
        .filter(field => field.name === name + 'Radio')
        .filter(field => [...(field.labels || [])].some(label => label.textContent.replace(/\\s+/g, '').trim() === '전체'));
      if (matched.length !== 1 || !/^[a-zA-Z0-9_-]{0,16}$/.test(matched[0].value)) return null;
      data[name] = matched[0].value;
    }
    if (!/^[1-9][0-9]{0,3}$/.test(data.pageRows) || Number(data.pageRows) > 1000) return null;
    Object.assign(data, {encCdno:'',startDt:${JSON.stringify(range.from.replaceAll('-', ''))},endDt:${JSON.stringify(range.to.replaceAll('-', ''))},pageNo:'1',nextKey:'',sortDv:'0'});
    return data;
  })()`
}

function formBody(plan: unknown, range: CardDateRange): string {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan))
    throw new Error('export_plan_unavailable')
  const keys = Object.keys(plan)
  if (
    keys.length !== FIELDS.length ||
    keys.some((key) => !(FIELDS as readonly string[]).includes(key))
  )
    throw new Error('export_plan_unavailable')
  const body = new URLSearchParams()
  for (const name of FIELDS) {
    const value = Object.getOwnPropertyDescriptor(plan, name)?.value
    if (
      typeof value !== 'string' ||
      value.length > 128 ||
      [...value].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      )
    )
      throw new Error('export_plan_unavailable')
    body.set(name, value)
  }
  if (
    body.get('encCdno') !== '' ||
    body.get('nextKey') !== '' ||
    body.get('pageNo') !== '1' ||
    body.get('sortDv') !== '0' ||
    body.get('startDt') !== range.from.replaceAll('-', '') ||
    body.get('endDt') !== range.to.replaceAll('-', '') ||
    !/^[1-9][0-9]{0,3}$/.test(body.get('pageRows')!) ||
    Number(body.get('pageRows')) > 1000 ||
    ['useCdDv', 'uplDv', 'useDv', 'stDv'].some(
      (name) => !/^[a-zA-Z0-9_-]{0,16}$/.test(body.get(name)!)
    )
  )
    throw new Error('export_plan_unavailable')
  return body.toString()
}

export async function exportLotteWorkbook(
  tab: Tab,
  range: CardDateRange,
  options: { signal?: AbortSignal } = {}
): Promise<LotteExcelExport> {
  if (!validRange(range)) throw new Error('invalid_export_range')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  timer.unref?.()
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal
  const wc = tab.view.webContents
  const initial = wc.getURL()
  let response: Response | undefined
  const context = (): void => {
    if (options.signal?.aborted) throw new Error('export_cancelled')
    if (controller.signal.aborted) throw new Error('export_timeout')
    if (wc.isDestroyed() || tab.view.webContents !== wc || wc.getURL() !== initial)
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
    context()
    if (!historyUrl(initial)) throw new Error('history_page_required')
    const auth = await bounded(pageBridge.cardSession(tab))
    context()
    if (auth.issuer !== 'lotte_card' || auth.state !== 'signed_in')
      throw new Error('authentication_required')
    const plan = await bounded(wc.executeJavaScript(planScript(range), false))
    context()
    const body = formBody(plan, range)
    response = await bounded(
      wc.session.fetch(ENDPOINT, {
        method: 'POST',
        credentials: 'include',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Referer: HISTORY
        },
        body,
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
      /<(?:table|Workbook)\b/i.test(bytes.subarray(0, 8192).toString('utf8'))
    if (!bytes.length || (!zip && !ole && !htmlExcel)) throw new Error('export_file_unrecognized')
    const finalAuth = await bounded(pageBridge.cardSession(tab))
    context()
    if (finalAuth.issuer !== 'lotte_card' || finalAuth.state !== 'signed_in')
      throw new Error('authentication_required')
    return {
      issuer: 'lotte_card',
      range: { ...range },
      service: SERVICE,
      bytes,
      extension: zip ? 'xlsx' : 'xls',
      expectedRows: null
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
    void response?.body?.cancel().catch(() => undefined)
  }
}
