import { z } from 'zod'
import type { Tab } from '../browser/tab-manager'
import { pageBridge } from '../browser/page-bridge'
import type { CardDateRange } from './card-api-types'
import { isCardDate } from './card-date-range'
import { requestPlanScript, type HyundaiApiForm } from './hyundai-api-collector'

const HISTORY_PATH = '/cpa/cb/CPACB0101_01.hc'
const QUERY_PATH = '/cpa/cb/apiCPACB0101_21.hc'
// Observed in the authenticated page's excelAction for recent approvals/all merchant types.
const EXPORT_PATH = '/cpa/cb/CPACB0101_105.hc'
const MAX_BYTES = 25 * 1024 * 1024
const MAX_QUERY_BYTES = 4 * 1024 * 1024
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
  scope: 'recent_approvals_all_cards_all_merchants'
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
  form: HyundaiApiForm
): Pick<
  HyundaiExcelExport,
  'expectedRows' | 'reportedTotal' | 'queryRows' | 'rowLimitPossible' | 'issues'
> {
  const own = (value: unknown, key: string): unknown =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.getOwnPropertyDescriptor(value, key)?.value
      : undefined
  const body = own(raw, 'bdy') ?? raw
  const items = own(body, 'rcntAvItm')
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
  'export_timeout'
])

/** Read-only issuer export; private response bytes must be saved locally, never sent in MCP output. */
export async function exportHyundaiWorkbook(
  tab: Tab,
  range: CardDateRange,
  options: { signal?: AbortSignal } = {}
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
    const parsed = planSchema.safeParse(
      await bounded(wc.executeJavaScript(requestPlanScript(range.from, range.to), false))
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
    let evidence: ReturnType<typeof countEvidence> = {
      expectedRows: null,
      reportedTotal: null,
      queryRows: null,
      rowLimitPossible: false,
      issues: ['query_count_unavailable']
    }
    try {
      const query = await bounded(
        wc.session.fetch(issuerOrigin + QUERY_PATH, {
          ...request,
          headers: { ...request.headers, 'X-Requested-With': 'XMLHttpRequest' }
        })
      )
      context()
      if (
        (query.url && query.url !== issuerOrigin + QUERY_PATH) ||
        !/^(?:application|text)\/json(?:;|$)/i.test(query.headers.get('content-type') ?? '')
      ) {
        void query.body?.cancel().catch(() => undefined)
        throw new Error('query_unavailable')
      }
      evidence = countEvidence(
        JSON.parse((await read(query, MAX_QUERY_BYTES)).toString('utf8')),
        form
      )
    } catch {
      context()
    }
    await authenticate()
    if (evidence.expectedRows === 0)
      return {
        issuer: 'hyundai_card',
        range: { ...range },
        scope: 'recent_approvals_all_cards_all_merchants',
        bytes: Buffer.alloc(0),
        extension: 'xls',
        ...evidence
      }
    const response = await bounded(wc.session.fetch(issuerOrigin + EXPORT_PATH, request))
    context()
    if (response.url && response.url !== issuerOrigin + EXPORT_PATH) {
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
    await authenticate()
    return {
      issuer: 'hyundai_card',
      range: { ...range },
      scope: 'recent_approvals_all_cards_all_merchants',
      bytes,
      extension: zip ? 'xlsx' : 'xls',
      ...evidence
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
