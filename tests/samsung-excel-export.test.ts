import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import type { Tab } from '../src/main/browser/tab-manager'
import { pageBridge } from '../src/main/browser/page-bridge'
import {
  exportSamsungWorkbook,
  SAMSUNG_EXCEL_SCOPES,
  type SamsungExcelScope
} from '../src/main/finance/samsung-excel-export'

const URL = 'https://www.samsungcard.com/personal/card/activity/UHPPRP0801M0.jsp'
const RANGE = { from: '2026-07-01', to: '2026-07-31' }
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])
const windows: JSDOM[] = []

function fixture(): {
  dom: JSDOM
  ENV: { CONDITION: Record<string, string | number> }
  query: ReturnType<typeof vi.fn>
  build: ReturnType<typeof vi.fn>
  fetch: ReturnType<typeof vi.fn>
  execute: ReturnType<typeof vi.fn>
  tab: Tab
  changeUrl: () => void
} {
  const dom = new JSDOM('', { url: URL, runScripts: 'outside-only' })
  windows.push(dom)
  const ENV = {
    CONDITION: {
      cardDvC: '1',
      cardKndC: '01',
      isCstMngtNo: 'PRIVATE_CUSTOMER',
      pssCstMngtNo: '0',
      cardCntrNo: '0',
      inqrStrtdt: 'OLD_DATE',
      strtAm: 100,
      endAm: 200,
      hidden: 'PRIVATE_UNRELATED'
    }
  }
  const query = vi.fn((settings) => {
    settings.success({ common: { procsRsDvC: '0' }, totDlngCt: 2, privateRows: 'NEVER_RETURN' })
  })
  const build = vi.fn((settings) => ({
    ...settings,
    data: JSON.stringify({ ...settings.data, common: { usid: 'PRIVATE_USER' } })
  }))
  Object.assign(dom.window, { ENV, scard: { ajax: query, buildAjaxSettings: build } })
  const fetch = vi.fn(
    async () =>
      new Response(OLE, {
        headers: {
          'Content-Type': 'application/vnd.ms-excel',
          'Content-Disposition': 'attachment;filename=card.xls'
        }
      })
  )
  let url = URL
  const execute = vi.fn(async (script: string, gesture: boolean) => {
    expect(gesture).toBe(false)
    return dom.window.eval(script)
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
  return {
    dom,
    ENV,
    query,
    build,
    fetch,
    execute,
    tab,
    changeUrl: () => {
      url = 'https://www.samsungcard.com/personal/login/UHPPCO0301M0.jsp'
    }
  }
}

beforeEach(() => {
  vi.spyOn(pageBridge, 'cardSession').mockResolvedValue({
    issuer: 'samsung_card',
    state: 'signed_in'
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const dom of windows.splice(0)) dom.window.close()
})

describe('Samsung fixed Excel exports', () => {
  it('downloads domestic monthly history using native export service and fresh all-card filters', async () => {
    const f = fixture()
    const before = JSON.stringify(f.ENV)
    const result = await exportSamsungWorkbook(f.tab, RANGE)
    expect(result).toMatchObject({
      issuer: 'samsung_card',
      scope: 'domestic',
      range: RANGE,
      service: 'SHPPRP0801S21',
      expectedRows: 2,
      extension: 'xls',
      bytes: OLE
    })
    expect(JSON.stringify(f.ENV)).toBe(before)
    expect(f.query.mock.calls[0][0]).toMatchObject({
      service: 'SHPPRP0801S51',
      data: {
        inqrStrtdt: '20260701',
        inqrEnddt: '20260731',
        pssCstMngtNo: '0',
        cardCntrNo: '0',
        strtAm: -99999999999,
        endAm: 99999999999,
        no9NextKeyCn: ''
      }
    })
    expect(f.fetch).toHaveBeenCalledOnce()
    const [url, options] = f.fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://www.samsungcard.com/frontservice/exceldownload')
    expect(options).toMatchObject({ method: 'POST', credentials: 'include', redirect: 'error' })
    const body = new URLSearchParams(String(options.body))
    expect([...body.keys()]).toEqual(['payload', 'serviceId', 'extention', 'separator', 'charset'])
    expect(body.get('serviceId')).toBe('SHPPRP0801S21')
    expect(JSON.parse(body.get('payload')!)).toMatchObject({
      prtgPrvwYn: 'Y',
      common: { usid: 'PRIVATE_USER' }
    })
    expect(body.get('payload')).not.toMatch(/PRIVATE_UNRELATED|OLD_DATE/)
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|NEVER_RETURN|payload/)
    expect(pageBridge.cardSession).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['domestic_cancellation', 'SHPPRP0801S12', 'SHPPRP0801S32', 'H', 7],
    ['overseas', 'SHPPRP0801S10', 'SHPPRP0801S30', '1', 4],
    ['overseas_cancellation', 'SHPPRP0801S13', 'SHPPRP0801S33', '3', 4],
    ['transport', 'SHPPRP0801S06', 'SHPPRP0801S26', 'D', 5],
    ['transport_tmoney', 'SHPPRP0801S06', 'SHPPRP0801S26', 'D', 5],
    ['hipass', 'SHPPRP0801S07', 'SHPPRP0801S26', 'E', 5]
  ] as const)(
    'uses only the observed %s query/export contract',
    async (scope, query, service, code, cursors) => {
      const f = fixture()
      const result = await exportSamsungWorkbook(f.tab, RANGE, { scope })
      expect(result).toMatchObject({ scope, service, expectedRows: 2 })
      const settings = f.query.mock.calls[0][0]
      expect(settings.service).toBe(query)
      expect(settings.data.cardUIzInqrDvC).toBe(code)
      expect(settings.data['no' + cursors + 'NextKeyCn']).toBe('')
      expect(settings.data['no' + (cursors + 1) + 'NextKeyCn']).toBeUndefined()
      if (scope.includes('cancellation')) expect(settings.data.canDvC).toBe('')
      if (scope === 'transport')
        expect(settings.data.afpymTrfcHips).toEqual({ uTrfcDvC: '0', uTrfcStlmDvC: 'A' })
      if (scope === 'transport_tmoney')
        expect(settings.data.afpymTrfcHips).toEqual({ uTrfcDvC: 'Z', uTrfcStlmDvC: 'M' })
    }
  )

  it('returns zero-count evidence without downloading a fake empty workbook', async () => {
    const f = fixture()
    f.query.mockImplementation((settings) =>
      settings.success({ common: { procsRsDvC: '0' }, totDlngCt: '0' })
    )
    const result = await exportSamsungWorkbook(f.tab, RANGE, { scope: 'overseas' })
    expect(result.expectedRows).toBe(0)
    expect(result.bytes.length).toBe(0)
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('rejects invalid dates, crossing months, unsupported scopes and single-card scope', async () => {
    const f = fixture()
    for (const range of [
      { from: '2026-07-31', to: '2026-08-01' },
      { from: '2026-07-32', to: '2026-07-32' },
      { from: '2026-07-10', to: '2026-07-01' }
    ])
      await expect(exportSamsungWorkbook(f.tab, range)).rejects.toThrow('invalid_export_range')
    await expect(
      exportSamsungWorkbook(f.tab, RANGE, { scope: 'payment' as SamsungExcelScope })
    ).rejects.toThrow('invalid_export_scope')
    f.ENV.CONDITION.cardCntrNo = 'SINGLE_CARD'
    await expect(exportSamsungWorkbook(f.tab, RANGE)).rejects.toThrow('card_scope_not_all')
    expect(f.fetch).not.toHaveBeenCalled()
    expect(SAMSUNG_EXCEL_SCOPES).toHaveLength(7)
  })

  it('does not download after sign-out, navigation, bad totals or a tampered export plan', async () => {
    const f = fixture()
    vi.mocked(pageBridge.cardSession).mockResolvedValueOnce({
      issuer: 'samsung_card',
      state: 'signed_out'
    })
    await expect(exportSamsungWorkbook(f.tab, RANGE)).rejects.toThrow('authentication_required')
    expect(f.execute).not.toHaveBeenCalled()
    f.query.mockImplementationOnce((settings) =>
      settings.success({ common: { procsRsDvC: '0' }, totDlngCt: 'SECRET_NOT_A_COUNT' })
    )
    await expect(exportSamsungWorkbook(f.tab, RANGE)).rejects.toThrow('invalid_response')
    f.build.mockImplementationOnce((settings) => ({
      ...settings,
      data: JSON.stringify({ ...settings.data, inqrStrtdt: '20200101' })
    }))
    await expect(exportSamsungWorkbook(f.tab, RANGE)).rejects.toThrow('export_plan_unavailable')
    f.query.mockImplementationOnce((settings) => {
      f.changeUrl()
      settings.success({ totDlngCt: 2 })
    })
    await expect(exportSamsungWorkbook(f.tab, RANGE)).rejects.toThrow('navigation_changed')
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('rejects login pages disguised as files and overlarge or interrupted downloads', async () => {
    const f = fixture()
    f.fetch.mockResolvedValueOnce(
      new Response('<html>login SECRET</html>', { headers: { 'Content-Type': 'text/html' } })
    )
    await expect(exportSamsungWorkbook(f.tab, RANGE)).rejects.toThrow('export_file_unrecognized')
    f.fetch.mockResolvedValueOnce(
      new Response(OLE, { headers: { 'content-length': String(26 * 1024 * 1024) } })
    )
    await expect(exportSamsungWorkbook(f.tab, RANGE)).rejects.toThrow('export_response_limit')
    f.fetch.mockRejectedValueOnce(new Error('SECRET request payload'))
    await expect(exportSamsungWorkbook(f.tab, RANGE)).rejects.toThrow('export_response_unavailable')
    const controller = new AbortController()
    controller.abort()
    await expect(
      exportSamsungWorkbook(f.tab, RANGE, { signal: controller.signal })
    ).rejects.toThrow('export_cancelled')
  })
})
