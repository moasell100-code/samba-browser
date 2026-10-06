import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import type { Tab } from '../src/main/browser/tab-manager'
import { pageBridge } from '../src/main/browser/page-bridge'
import { exportHyundaiWorkbook } from '../src/main/finance/hyundai-excel-export'
import {
  requestHyundaiApiPage,
  type HyundaiApiForm
} from '../src/main/finance/hyundai-api-collector'

const HISTORY = 'https://www.hyundaicard.com/cpa/cb/CPACB0101_01.hc'
const RANGE = { from: '2026-07-01', to: '2026-07-31' }
const workbook = (count: number, date = '2026년 07월 01일'): Buffer =>
  Buffer.from(
    `<html><table><tr>${['승인일', '승인시각', '카드구분', '카드종류', '가맹점명', '승인금액', '이용구분', '할부개월', '승인번호', '취소일', '승인구분'].map((header) => `<th>${header}</th>`).join('')}</tr>${Array.from({ length: count }, () => `<tr><td>${date}</td>${'<td>PRIVATE</td>'.repeat(10)}</tr>`).join('')}</table></html>`
  )
const windows: JSDOM[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dom of windows.splice(0)) dom.window.close()
})

function fixture(count = 2): {
  dom: JSDOM
  tab: Tab
  fetch: ReturnType<typeof vi.fn>
  execute: ReturnType<typeof vi.fn>
  auth: ReturnType<typeof vi.spyOn<typeof pageBridge, 'hyundaiAuth'>>
  setUrl: (value: string) => void
} {
  const dom = new JSDOM(
    `<form id="form1">
    <select name="crno"><option value="ALL_PRIVATE_CARDS">전체</option><option selected value="ONE_PRIVATE_CARD">개별 카드</option></select>
    <input name="dmfrClsf" type="hidden" value=""><input name="sortType" type="hidden" value="SORT_PRIVATE">
    <input name="dtClsf" id="dtClsf_04" type="radio" value="DIRECT_PRIVATE"><label for="dtClsf_04">직접 입력</label>
    <input name="listClsf" id="listClsf_01" type="radio" value="RECENT_PRIVATE">
    <input name="listClsf" id="listClsf_02" type="radio" value="ACQUIRED_PRIVATE">
    <input id="iqrySrtDt" type="hidden" value="20261001"><input id="iqryEndDt" type="hidden" value="20261006">
    ${['useClsf', 'usplClsf', 'zoneClsf'].map((name) => `<input name="${name}" type="radio" id="${name}_all" value="ALL_PRIVATE_${name}"><label for="${name}_all">전체</label>`).join('')}
    <input name="password" type="password" value="NEVER_EXPORT_PASSWORD">
  </form>`,
    { url: HISTORY, runScripts: 'outside-only' }
  )
  windows.push(dom)
  let url = HISTORY
  const fetch = vi.fn(async (endpoint: string, options: RequestInit) => {
    if (/apiCPACB0101_2[12]\.hc$/.test(endpoint)) {
      const data = Object.fromEntries(new URLSearchParams(String(options.body)))
      return new Response(
        JSON.stringify({
          bdy: {
            rcntSummaryInfo: {
              ...data,
              ...(endpoint.endsWith('_22.hc') ? { usplClsf: '' } : {}),
              totUseCnt: count
            },
            [endpoint.endsWith('_22.hc') ? 'acqrUseItmList' : 'rcntAvItm']: Array.from(
              { length: count },
              () => ({ private: 'NOT_RETURNED' })
            )
          }
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    }
    return new Response(workbook(count), {
      headers: { 'content-type': 'application/vnd.ms-excel' }
    })
  })
  const execute = vi.fn(async (code: string, gesture: boolean) => {
    expect(gesture).toBe(false)
    return dom.window.eval(code)
  })
  const tab = {
    view: {
      webContents: {
        getURL: () => url,
        isDestroyed: () => false,
        executeJavaScript: execute,
        session: { fetch }
      }
    }
  } as unknown as Tab
  const auth = vi.spyOn(pageBridge, 'hyundaiAuth').mockResolvedValue({ state: 'signed_in' })
  return {
    dom,
    tab,
    fetch,
    execute,
    auth,
    setUrl: (value) => {
      url = value
    }
  }
}

describe('Hyundai recent approval Excel export', () => {
  it('uses the observed 105 export and full-card form plan while leaving current screen filters untouched', async () => {
    const f = fixture()
    const before = f.dom.window.document.documentElement.outerHTML
    const result = await exportHyundaiWorkbook(f.tab, RANGE)
    expect(result).toMatchObject({
      issuer: 'hyundai_card',
      range: RANGE,
      scope: 'recent_approvals_all_cards_all_merchants',
      expectedRows: 2,
      reportedTotal: 2,
      queryRows: 2,
      rowLimitPossible: false,
      issues: [],
      bytes: workbook(2),
      extension: 'xls'
    })
    expect(f.fetch.mock.calls.map((call) => call[0])).toEqual([
      'https://www.hyundaicard.com/cpa/cb/apiCPACB0101_21.hc',
      'https://www.hyundaicard.com/cpa/cb/CPACB0101_105.hc'
    ])
    const request = f.fetch.mock.calls[1][1] as RequestInit
    expect(request).toMatchObject({ method: 'POST', credentials: 'include', redirect: 'error' })
    const body = Object.fromEntries(new URLSearchParams(String(request.body)))
    expect(body).toMatchObject({
      srtDt: '20260701',
      endDt: '20260731',
      crno: 'ALL_PRIVATE_CARDS',
      dtClsf: 'DIRECT_PRIVATE',
      listClsf: 'RECENT_PRIVATE',
      zoneClsf: 'ALL_PRIVATE_zoneClsf',
      usplClsf: 'ALL_PRIVATE_usplClsf',
      useClsf: 'ALL_PRIVATE_useClsf'
    })
    expect(Object.keys(body)).toHaveLength(10)
    expect(String(request.body)).not.toContain('PASSWORD')
    expect(f.dom.window.document.documentElement.outerHTML).toBe(before)
    expect(JSON.stringify({ ...result, bytes: undefined })).not.toMatch(
      /PRIVATE|NOT_RETURNED|PASSWORD/
    )
    expect(f.auth).toHaveBeenCalledTimes(3)
  })

  it('marks potential 630-row caps and never treats capped monthly counts as completeness evidence', async () => {
    const f = fixture(630)
    const result = await exportHyundaiWorkbook(f.tab, RANGE)
    expect(result).toMatchObject({
      expectedRows: null,
      reportedTotal: 630,
      queryRows: 630,
      rowLimitPossible: true,
      issues: ['export_row_limit_possible']
    })
  })

  it('supports the separately selected, observed posted-purchase query and export routes', async () => {
    const f = fixture()
    const result = await exportHyundaiWorkbook(f.tab, RANGE, { mode: 'acquired' })
    expect(result.scope).toBe('acquired_purchases_all_cards_all_merchants')
    expect(f.fetch.mock.calls.map((call) => call[0])).toEqual([
      'https://www.hyundaicard.com/cpa/cb/apiCPACB0101_22.hc',
      'https://www.hyundaicard.com/cpa/cb/CPACB0101_10.hc'
    ])
    expect(new URLSearchParams(String(f.fetch.mock.calls[0][1].body)).get('listClsf')).toBe(
      'ACQUIRED_PRIVATE'
    )
  })

  it('validates a uniquely labelled historical transaction-date column independently of importer columns', async () => {
    const f = fixture()
    const original = f.fetch.getMockImplementation()!
    f.fetch.mockImplementation(async (endpoint, options) =>
      endpoint.endsWith('CPACB0101_10.hc')
        ? new Response(
            workbook(2, '2026-07-01')
              .toString()
              .replace('<table>', '<table><tr><td colspan="12"></td></tr>')
              .replace('<th>승인일</th>', '<th>이용일</th>'),
            { headers: { 'content-type': 'application/vnd.ms-excel' } }
          )
        : original(endpoint, options)
    )
    expect((await exportHyundaiWorkbook(f.tab, RANGE, { mode: 'acquired' })).expectedRows).toBe(2)
  })

  it('returns only structural workbook diagnostics when an observed layout cannot be validated', async () => {
    const f = fixture()
    const original = f.fetch.getMockImplementation()!
    f.fetch.mockImplementation(async (endpoint, options) =>
      endpoint.endsWith('_105.hc')
        ? new Response(
            '<table><tr><th>이용일</th><th>PRIVATE_HEADER</th></tr><tr><td>PRIVATE_PERSON 2026</td><td>PRIVATE_VALUE</td></tr></table>',
            { headers: { 'content-type': 'application/vnd.ms-excel' } }
          )
        : original(endpoint, options)
    )
    try {
      await exportHyundaiWorkbook(f.tab, RANGE)
      expect.fail('must reject unknown layout')
    } catch (error) {
      expect((error as Error).message).toBe('export_date_schema_unverified')
      expect(JSON.stringify(error)).not.toContain('PRIVATE')
      expect(error).toMatchObject({
        diagnostic: {
          headerLabels: [['이용일', '[unrecognized]']],
          cellCounts: [0, 2],
          stage: 'headers'
        }
      })
    }
  })

  it('validates the leading date and count without discarding issuer rows containing an extra cell', async () => {
    const f = fixture()
    const original = f.fetch.getMockImplementation()!
    f.fetch.mockImplementation(async (endpoint, options) =>
      endpoint.endsWith('_105.hc')
        ? new Response(
            workbook(2)
              .toString()
              .replaceAll('<td>PRIVATE</td></tr>', '<td>PRIVATE</td><td>EXTRA_PRIVATE</td></tr>'),
            { headers: { 'content-type': 'application/vnd.ms-excel' } }
          )
        : original(endpoint, options)
    )
    expect((await exportHyundaiWorkbook(f.tab, RANGE)).expectedRows).toBe(2)
  })

  it('skips downloads only for a verified empty all-card range', async () => {
    const f = fixture(0)
    const result = await exportHyundaiWorkbook(f.tab, RANGE)
    expect(result.expectedRows).toBe(0)
    expect(result.bytes.length).toBe(0)
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })

  it('never downloads a potentially cached workbook after an unavailable query', async () => {
    const f = fixture()
    f.fetch.mockRejectedValueOnce(new Error('PRIVATE_QUERY_FAILURE'))
    await expect(exportHyundaiWorkbook(f.tab, RANGE)).rejects.toThrow('query_response_unavailable')
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })

  it('requires the query to confirm both the date range and all-card scope before export', async () => {
    const f = fixture()
    f.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          bdy: {
            rcntSummaryInfo: { totUseCnt: 2, srtDt: '20260920', endDt: '20261006' },
            rcntAvItm: [{}, {}]
          }
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    )
    await expect(exportHyundaiWorkbook(f.tab, RANGE)).rejects.toThrow('query_scope_unverified')
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects an apparently valid file containing another date range before returning bytes', async () => {
    const f = fixture()
    f.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          bdy: {
            rcntSummaryInfo: {
              srtDt: '20260701',
              endDt: '20260731',
              crno: 'ALL_PRIVATE_CARDS',
              dtClsf: 'DIRECT_PRIVATE',
              useClsf: 'ALL_PRIVATE_useClsf',
              usplClsf: 'ALL_PRIVATE_usplClsf',
              zoneClsf: 'ALL_PRIVATE_zoneClsf',
              totUseCnt: 2
            },
            rcntAvItm: [{}, {}]
          }
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    )
    f.fetch.mockResolvedValueOnce(
      new Response(workbook(2, '2026년 09월 20일'), {
        headers: { 'content-type': 'application/vnd.ms-excel' }
      })
    )
    await expect(exportHyundaiWorkbook(f.tab, RANGE)).rejects.toThrow('export_range_mismatch')
  })

  it('rejects ambiguous all-card controls, stale date plans, overlong ranges and preserves existing API four-day limits', async () => {
    const f = fixture()
    await expect(
      exportHyundaiWorkbook(f.tab, { from: '2026-07-01', to: '2026-08-01' })
    ).rejects.toThrow('invalid_export_range')
    const select = f.dom.window.document.querySelector('select')!
    select.append(select.options[0].cloneNode(true))
    await expect(exportHyundaiWorkbook(f.tab, RANGE)).rejects.toThrow('card_selector_unverified')
    expect(f.fetch).not.toHaveBeenCalled()
    const form = {
      crno: '',
      dmfrClsf: '',
      dtClsf: '',
      endDt: '20260731',
      listClsf: '',
      sortType: '',
      srtDt: '20260701',
      useClsf: '',
      usplClsf: '',
      zoneClsf: ''
    } satisfies HyundaiApiForm
    await expect(requestHyundaiApiPage(f.tab, form)).rejects.toThrow('hyundai_request_invalid')
  })

  it('rejects session expiry, navigation and non-workbook responses with fixed safe errors', async () => {
    const signedOut = fixture()
    signedOut.auth.mockResolvedValueOnce({ state: 'signed_out' })
    await expect(exportHyundaiWorkbook(signedOut.tab, RANGE)).rejects.toThrow(
      'authentication_required'
    )
    expect(signedOut.fetch).not.toHaveBeenCalled()
    const moving = fixture()
    moving.execute.mockImplementationOnce(async (code: string) => {
      const raw = moving.dom.window.eval(code)
      moving.setUrl('https://www.hyundaicard.com/index.jsp')
      return raw
    })
    await expect(exportHyundaiWorkbook(moving.tab, RANGE)).rejects.toThrow('navigation_changed')
    const loginHtml = fixture()
    loginHtml.fetch.mockImplementation(
      async () =>
        new Response('<html>PRIVATE_LOGIN</html>', { headers: { 'content-type': 'text/html' } })
    )
    await expect(exportHyundaiWorkbook(loginHtml.tab, RANGE)).rejects.toThrow(
      'query_response_non_json'
    )
    const aborted = fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(
      exportHyundaiWorkbook(aborted.tab, RANGE, { signal: controller.signal })
    ).rejects.toThrow('export_cancelled')
  })
})
