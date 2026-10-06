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
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])
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
    <input id="iqrySrtDt" type="hidden" value="20261001"><input id="iqryEndDt" type="hidden" value="20261006">
    ${['useClsf', 'usplClsf', 'zoneClsf'].map((name) => `<input name="${name}" type="radio" id="${name}_all" value="ALL_PRIVATE_${name}"><label for="${name}_all">전체</label>`).join('')}
    <input name="password" type="password" value="NEVER_EXPORT_PASSWORD">
  </form>`,
    { url: HISTORY, runScripts: 'outside-only' }
  )
  windows.push(dom)
  let url = HISTORY
  const fetch = vi.fn(async (endpoint: string, options: RequestInit) => {
    if (endpoint.endsWith('apiCPACB0101_21.hc')) {
      const data = Object.fromEntries(new URLSearchParams(String(options.body)))
      return new Response(
        JSON.stringify({
          bdy: {
            rcntSummaryInfo: { ...data, totUseCnt: count },
            rcntAvItm: Array.from({ length: count }, () => ({ private: 'NOT_RETURNED' }))
          }
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    }
    return new Response(OLE, { headers: { 'content-type': 'application/vnd.ms-excel' } })
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
      bytes: OLE,
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
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|NOT_RETURNED|PASSWORD/)
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

  it('skips downloads only for a verified empty all-card range', async () => {
    const f = fixture(0)
    const result = await exportHyundaiWorkbook(f.tab, RANGE)
    expect(result.expectedRows).toBe(0)
    expect(result.bytes.length).toBe(0)
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })

  it('continues an Excel download with explicit unverified count when the count endpoint is unavailable', async () => {
    const f = fixture()
    f.fetch.mockRejectedValueOnce(new Error('PRIVATE_QUERY_FAILURE'))
    const result = await exportHyundaiWorkbook(f.tab, RANGE)
    expect(result).toMatchObject({
      expectedRows: null,
      reportedTotal: null,
      queryRows: null,
      issues: ['query_count_unavailable']
    })
    expect(result.bytes).toEqual(OLE)
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
      'export_file_unrecognized'
    )
    const aborted = fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(
      exportHyundaiWorkbook(aborted.tab, RANGE, { signal: controller.signal })
    ).rejects.toThrow('export_cancelled')
  })
})
