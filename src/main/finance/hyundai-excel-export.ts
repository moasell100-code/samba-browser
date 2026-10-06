import { z } from 'zod'
import { parse } from 'node-html-parser'
import type { Tab } from '../browser/tab-manager'
import { pageBridge } from '../browser/page-bridge'
import type { CardDateRange } from './card-api-types'
import { isCardDate } from './card-date-range'
import { requestPlanScript, type HyundaiApiForm } from './hyundai-api-collector'

const HISTORY_PATH = '/cpa/cb/CPACB0101_01.hc'
const QUERY_PATH = '/cpa/cb/apiCPACB0101_21.hc'
// Observed in the authenticated page's excelAction for recent approvals/all merchant types.
const EXPORT_PATH = '/cpa/cb/CPACB0101_105.hc'
// Observed in goFilter/goAjax and excelAction for listClsf_02 (posted purchases).
const ACQUIRED_QUERY_PATH = '/cpa/cb/apiCPACB0101_22.hc'
const ACQUIRED_EXPORT_PATH = '/cpa/cb/CPACB0101_10.hc'
const MAX_BYTES = 25 * 1024 * 1024
const MAX_QUERY_BYTES = 4 * 1024 * 1024
const EXCEL_HEADERS = [
  '승인일',
  '승인시각',
  '카드구분',
  '카드종류',
  '가맹점명',
  '승인금액',
  '이용구분',
  '할부개월',
  '승인번호',
  '취소일',
  '승인구분'
]
const FIELDS = [
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
const valueSchema = z
  .string()
  .max(256)
  .refine((value) =>
    [...value].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    )
  )
const formSchema = z
  .object({
    crno: valueSchema,
    dmfrClsf: valueSchema,
    dtClsf: valueSchema,
    endDt: valueSchema,
    listClsf: valueSchema,
    sortType: valueSchema,
    srtDt: valueSchema,
    useClsf: valueSchema,
    usplClsf: valueSchema,
    zoneClsf: valueSchema
  })
  .strict()
const planSchema = z.discriminatedUnion('ok', [
  z
    .object({ ok: z.literal(true), data: formSchema, cardTails: z.array(z.unknown()).max(100) })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      issue: z.enum([
        'history_page_required',
        'request_schema_unverified',
        'card_selector_unverified'
      ])
    })
    .strict()
])

export interface HyundaiExcelExport {
  issuer: 'hyundai_card'
  range: CardDateRange
  scope: 'recent_approvals_all_cards_all_merchants' | 'acquired_purchases_all_cards_all_merchants'
  bytes: Buffer
  extension: 'xls' | 'xlsx'
  /** Null when the API count is capped/unverified; the workbook still requires validation. */
  expectedRows: number | null
  reportedTotal: number | null
  queryRows: number | null
  rowLimitPossible: boolean
  issues: string[]
}

function origin(value: string): string | null {
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

function validRange(range: CardDateRange): boolean {
  return (
    isCardDate(range.from) &&
    isCardDate(range.to) &&
    range.from <= range.to &&
    Date.parse(range.to) - Date.parse(range.from) <= 30 * 86400000
  )
}

function countEvidence(
  raw: unknown,
  form: HyundaiApiForm,
  mode: 'recent' | 'acquired'
): Pick<
  HyundaiExcelExport,
  'expectedRows' | 'reportedTotal' | 'queryRows' | 'rowLimitPossible' | 'issues'
> {
  const own = (value: unknown, key: string): unknown =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.getOwnPropertyDescriptor(value, key)?.value
      : undefined
  const body = own(raw, 'bdy') ?? raw
  const items = own(body, mode === 'acquired' ? 'acqrUseItmList' : 'rcntAvItm')
  const summary = own(body, 'rcntSummaryInfo')
  const count = String(own(summary, 'totUseCnt') ?? '')
  const reportedTotal =
    /^\d{1,7}$/.test(count) && Number.isSafeInteger(Number(count)) ? Number(count) : null
  const queryRows = Array.isArray(items) ? items.length : null
  const rowLimitPossible = Math.max(reportedTotal ?? 0, queryRows ?? 0) >= 630
  const issues: string[] = []
  if (own(body, 'error_code') && own(body, 'error_message')) issues.push('query_service_error')
  if (reportedTotal === null || queryRows === null) issues.push('query_count_unverified')
  else if (reportedTotal !== queryRows) issues.push('query_count_mismatch')
  for (const field of [
    'srtDt',
    'endDt',
    'crno',
    'dtClsf',
    'useClsf',
    'usplClsf',
    'zoneClsf'
  ] as const) {
    const returned = own(summary, field)
    const expected = form[field]
    if (
      (typeof returned !== 'string' && typeof returned !== 'number') ||
      String(returned).replaceAll('-', '') !== expected.replaceAll('-', '')
    ) {
      issues.push('query_scope_unverified')
      break
    }
  }
  if (rowLimitPossible) issues.push('export_row_limit_possible')
  return {
    expectedRows: issues.length ? null : reportedTotal,
    reportedTotal,
    queryRows,
    rowLimitPossible,
    issues
  }
}

/** Validate only the observed issuer HTML workbook's date column, without emitting row data. */
export class HyundaiExportValidationError extends Error {
  constructor(
    public readonly diagnostic: {
      headerLabels: string[][]
      cellCounts: number[]
      dateShapes: string[]
      stage: string
    }
  ) {
    super('export_date_schema_unverified')
  }
}

function validateWorkbookDates(bytes: Buffer, range: CardDateRange): number {
  const html = bytes.toString('utf8')
  if (!/<(?:html|table)\b/i.test(html.slice(0, 8192)))
    throw new Error('export_date_schema_unverified')
  const document = parse(html)
  const publicLabels = new Set([
    ...EXCEL_HEADERS,
    '이용일',
    '이용일자',
    '매출일자',
    '매입일자',
    '카드번호',
    '가맹점',
    '이용금액',
    '이용금액(원)',
    '청구금액',
    '수수료',
    '결제예정일',
    '접수일',
    '전표접수일',
    '이용국가',
    '통화',
    '해외이용금액',
    '매출구분',
    '카드명',
    '이용구분',
    '할부개월수',
    '승인번호',
    '카드구분'
  ])
  const diagnostic = {
    headerLabels: document
      .querySelectorAll('tr')
      .filter((row) => row.querySelectorAll('th').length > 1)
      .slice(0, 5)
      .map((row) =>
        row
          .querySelectorAll('th')
          .slice(0, 30)
          .map((cell) => (publicLabels.has(cell.text.trim()) ? cell.text.trim() : '[unrecognized]'))
      ),
    cellCounts: [
      ...new Set(document.querySelectorAll('tr').map((row) => row.querySelectorAll('td').length))
    ].slice(0, 15),
    dateShapes: [
      ...new Set(
        document
          .querySelectorAll('tr')
          .map((row) => row.querySelector('td')?.text.trim())
          .filter((value) => value !== undefined)
          .map((value) =>
            String(value)
              .replace(/\d/g, 'd')
              .replace(/[^d년월일\s/.:-]/g, '?')
              .slice(0, 45)
          )
      )
    ].slice(0, 15),
    stage: 'headers'
  }
  const fail = (stage: string): never => {
    throw new HyundaiExportValidationError({ ...diagnostic, stage })
  }
  const tables = document.querySelectorAll('table').filter((table) =>
    table.querySelectorAll('tr').some((row) => {
      const headers = row.querySelectorAll('th').map((cell) => cell.text.trim())
      return (
        headers.length === EXCEL_HEADERS.length &&
        headers.every((text, index) => text === EXCEL_HEADERS[index])
      )
    })
  )
  if (tables.length !== 1) fail('headers')
  let count = 0
  for (const row of tables[0].querySelectorAll('tr')) {
    const cells = row.querySelectorAll('td')
    if (!cells.length) continue
    if (cells.length !== EXCEL_HEADERS.length) fail('cells')
    const raw = cells[0].text.trim()
    if (raw === '-') continue // The observed export has three total rows with a dash in this column.
    const match = /^(\d{4})년\s+(\d{2})월\s+(\d{2})일$/.exec(raw)
    if (!match) return fail('date')
    const date = `${match[1]}-${match[2]}-${match[3]}`
    if (!isCardDate(date)) fail('date')
    if (date < range.from || date > range.to) throw new Error('export_range_mismatch')
    count += 1
  }
  return count
}

const SAFE_ERRORS = new Set([
  'invalid_export_range',
  'history_page_required',
  'authentication_required',
  'navigation_changed',
  'request_schema_unverified',
  'card_selector_unverified',
  'export_plan_unavailable',
  'export_response_unavailable',
  'export_response_limit',
  'export_file_unrecognized',
  'export_cancelled',
  'export_timeout',
  'query_scope_unverified',
  'query_count_unverified',
  'query_count_mismatch',
  'query_response_non_json',
  'query_response_http',
  'query_response_unavailable',
  'query_service_error',
  'export_range_mismatch',
  'export_date_schema_unverified',
  'export_count_mismatch'
])

/** Read-only issuer export; private response bytes must be saved locally, never sent in MCP output. */
export async function exportHyundaiWorkbook(
  tab: Tab,
  range: CardDateRange,
  options: { signal?: AbortSignal; mode?: 'recent' | 'acquired' } = {}
): Promise<HyundaiExcelExport> {
  if (!validRange(range)) throw new Error('invalid_export_range')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  timer.unref?.()
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal
  let wc: Tab['view']['webContents']
  let url: string
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
  const authenticate = async (): Promise<void> => {
    const auth = await bounded(pageBridge.hyundaiAuth(tab))
    context()
    if (auth.state !== 'signed_in') throw new Error('authentication_required')
  }
  const read = async (response: Response, max: number): Promise<Buffer> => {
    if (!response.ok || !response.body) throw new Error('export_response_unavailable')
    const length = response.headers.get('content-length')
    if (length && (!/^\d+$/.test(length) || Number(length) > max)) {
      void response.body.cancel().catch(() => undefined)
      throw new Error('export_response_limit')
    }
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let size = 0
    try {
      for (;;) {
        const chunk = await bounded(reader.read())
        context()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > max) throw new Error('export_response_limit')
        chunks.push(Buffer.from(chunk.value))
      }
    } finally {
      void reader.cancel().catch(() => undefined)
    }
    return Buffer.concat(chunks)
  }
  try {
    wc = tab.view.webContents
    url = wc.getURL()
    const issuerOrigin = origin(url)
    if (!issuerOrigin) throw new Error('history_page_required')
    await authenticate()
    const mode = options.mode ?? 'recent'
    const queryPath = mode === 'acquired' ? ACQUIRED_QUERY_PATH : QUERY_PATH
    const exportPath = mode === 'acquired' ? ACQUIRED_EXPORT_PATH : EXPORT_PATH
    const scope =
      mode === 'acquired'
        ? 'acquired_purchases_all_cards_all_merchants'
        : 'recent_approvals_all_cards_all_merchants'
    const parsed = planSchema.safeParse(
      await bounded(wc.executeJavaScript(requestPlanScript(range.from, range.to, mode), false))
    )
    context()
    if (!parsed.success) throw new Error('export_plan_unavailable')
    if (!parsed.data.ok) throw new Error(parsed.data.issue)
    const form = parsed.data.data
    if (
      form.srtDt.replaceAll('-', '') !== range.from.replaceAll('-', '') ||
      form.endDt.replaceAll('-', '') !== range.to.replaceAll('-', '')
    )
      throw new Error('export_plan_unavailable')
    const body = new URLSearchParams()
    for (const field of FIELDS) body.set(field, form[field])
    const request = {
      method: 'POST',
      credentials: 'include',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Referer: issuerOrigin + HISTORY_PATH
      },
      body: body.toString(),
      signal
    } as const
    let evidence: ReturnType<typeof countEvidence>
    try {
      const query = await bounded(
        wc.session.fetch(issuerOrigin + queryPath, {
          ...request,
          headers: { ...request.headers, 'X-Requested-With': 'XMLHttpRequest' }
        })
      )
      context()
      if (!query.ok) {
        void query.body?.cancel().catch(() => undefined)
        throw new Error('query_response_http')
      }
      if (query.url && query.url !== issuerOrigin + queryPath) {
        void query.body?.cancel().catch(() => undefined)
        throw new Error('query_response_unavailable')
      }
      if (!/^(?:application|text)\/json(?:;|$)/i.test(query.headers.get('content-type') ?? '')) {
        void query.body?.cancel().catch(() => undefined)
        throw new Error('query_response_non_json')
      }
      evidence = countEvidence(
        JSON.parse((await read(query, MAX_QUERY_BYTES)).toString('utf8')),
        form,
        mode
      )
    } catch (error) {
      context()
      throw new Error(
        error instanceof Error && SAFE_ERRORS.has(error.message)
          ? error.message
          : 'query_response_unavailable'
      )
    }
    // The Excel endpoint can return the last successful server-side query even when the
    // posted dates differ. Never download until the fresh query echoes the requested scope.
    const failure = evidence.issues.find((issue) => issue !== 'export_row_limit_possible')
    if (failure) throw new Error(failure)
    await authenticate()
    if (evidence.expectedRows === 0)
      return {
        issuer: 'hyundai_card',
        range: { ...range },
        scope,
        bytes: Buffer.alloc(0),
        extension: 'xls',
        ...evidence
      }
    const response = await bounded(wc.session.fetch(issuerOrigin + exportPath, request))
    context()
    if (response.url && response.url !== issuerOrigin + exportPath) {
      void response.body?.cancel().catch(() => undefined)
      throw new Error('export_response_unavailable')
    }
    const bytes = await read(response, MAX_BYTES)
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
    const workbookRows = validateWorkbookDates(bytes, range)
    if (evidence.expectedRows !== null && workbookRows !== evidence.expectedRows)
      throw new Error('export_count_mismatch')
    await authenticate()
    return {
      issuer: 'hyundai_card',
      range: { ...range },
      scope,
      bytes,
      extension: zip ? 'xlsx' : 'xls',
      ...evidence
    }
  } catch (error) {
    if (options.signal?.aborted) throw new Error('export_cancelled')
    if (controller.signal.aborted) throw new Error('export_timeout')
    if (error instanceof HyundaiExportValidationError) throw error
    throw new Error(
      error instanceof Error && SAFE_ERRORS.has(error.message)
        ? error.message
        : 'export_response_unavailable'
    )
  } finally {
    clearTimeout(timer)
  }
}
