import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import type { Tab } from '../src/main/browser/tab-manager'
const auth = vi.hoisted(() => vi.fn())
vi.mock('../src/main/browser/page-bridge', () => ({ pageBridge: { cardSession: auth } }))
import { exportLotteWorkbook } from '../src/main/finance/lotte-excel-export'

const HISTORY = 'https://www.lottecard.co.kr/app/LPMCDAA_V100.lc'
const EXPORT = 'https://www.lottecard.co.kr/app/LPMCDAA_V101.lc'
const RANGE = { from: '2026-07-01', to: '2026-07-31' }
const windows: JSDOM[] = []
const DEFAULTS = {
  encCdno: 'synthetic-private-selected-card',
  endDt: '20261006',
  inqTeDt: '20261006',
  nextKey: 'synthetic-private-cursor',
  pageNo: '2',
  pageRows: '10',
  ptnBnkYn: 'N',
  schDv: '0',
  sortDv: '1',
  sortObj: '0',
  stDv: '1',
  startDt: '20261001',
  uplDv: '1',
  useCdDv: '1',
  useDv: '1'
}

function fixture(): {
  tab: Tab
  dom: JSDOM
  fetch: ReturnType<typeof vi.fn>
  navigate: (url: string) => void
} {
  const html =
    `<form name="LPMCDAAAprUseList">${Object.entries(DEFAULTS)
      .map(([name, value]) => `<input type="hidden" name="${name}" value="${value}">`)
      .join('')}</form><input type="checkbox" id="useCarditemAll">` +
    ['useCdDv', 'uplDv', 'useDv', 'stDv']
      .map(
        (name) =>
          `<input type="radio" id="${name}All" name="${name}Radio" value="0"><label for="${name}All">전체</label><input type="radio" name="${name}Radio" value="1" checked>`
      )
      .join('')
  const dom = new JSDOM(html, { url: HISTORY, runScripts: 'outside-only' })
  windows.push(dom)
  const fetch = vi.fn().mockImplementation(
    async () =>
      new Response(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), {
        headers: { 'content-type': 'application/vnd.ms-excel' }
      })
  )
  let currentUrl = HISTORY
  const tab = {
    view: {
      webContents: {
        isDestroyed: () => false,
        getURL: () => currentUrl,
        executeJavaScript: vi.fn((script: string) => Promise.resolve(dom.window.eval(script))),
        session: { fetch }
      }
    }
  } as unknown as Tab
  return {
    tab,
    dom,
    fetch,
    navigate: (url) => {
      currentUrl = url
    }
  }
}

beforeEach(() => auth.mockReset().mockResolvedValue({ issuer: 'lotte_card', state: 'signed_in' }))
afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close()
  vi.useRealTimers()
})

describe('Lotte historical workbook export', () => {
  it('posts the verified complete form with explicit range and all-card/all-status filters without changing the page', async () => {
    const f = fixture()
    const before = f.dom.window.document.body.innerHTML
    const result = await exportLotteWorkbook(f.tab, RANGE)
    expect(f.fetch).toHaveBeenCalledTimes(1)
    expect(f.fetch.mock.calls[0][0]).toBe(EXPORT)
    const request = f.fetch.mock.calls[0][1]
    expect(request).toMatchObject({
      method: 'POST',
      credentials: 'include',
      redirect: 'error',
      headers: { Referer: HISTORY }
    })
    const body = Object.fromEntries(new URLSearchParams(request.body))
    expect(body).toEqual({
      ...DEFAULTS,
      encCdno: '',
      startDt: '20260701',
      endDt: '20260731',
      pageNo: '1',
      nextKey: '',
      sortDv: '0',
      useCdDv: '0',
      uplDv: '0',
      useDv: '0',
      stDv: '0'
    })
    expect(f.dom.window.document.body.innerHTML).toBe(before)
    expect(result).toMatchObject({
      issuer: 'lotte_card',
      service: 'LPMCDAA_V101',
      range: RANGE,
      extension: 'xls',
      expectedRows: null
    })
    expect(result.bytes).toHaveLength(8)
    expect(auth).toHaveBeenCalledTimes(2)
  })

  it.each([
    { from: '2026-07-01', to: '2026-08-01' },
    { from: '2026-02-29', to: '2026-03-01' },
    { from: '2026-07-31', to: '2026-07-01' }
  ])('rejects invalid or over-31-day ranges before accessing the session (%j)', async (range) => {
    const f = fixture()
    await expect(exportLotteWorkbook(f.tab, range)).rejects.toThrow('invalid_export_range')
    expect(auth).not.toHaveBeenCalled()
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it.each(['missing-all-radio', 'extra-form-field', 'duplicate-field', 'password-field'])(
    'fails closed on changed export form semantics (%s)',
    async (change) => {
      const f = fixture()
      const doc = f.dom.window.document
      if (change === 'missing-all-radio') doc.querySelector('#stDvAll')!.remove()
      else if (change === 'password-field')
        (doc.querySelector('[name="encCdno"]') as HTMLInputElement).type = 'password'
      else
        doc
          .querySelector('form')!
          .insertAdjacentHTML(
            'beforeend',
            `<input type="hidden" name="${change === 'duplicate-field' ? 'startDt' : 'privateUnexpectedField'}" value="synthetic-private-value">`
          )
      await expect(exportLotteWorkbook(f.tab, RANGE)).rejects.toThrow('export_plan_unavailable')
      expect(f.fetch).not.toHaveBeenCalled()
    }
  )

  it('requires the issuer history tab and signed-in session', async () => {
    const f = fixture()
    f.navigate('https://example.invalid/app/LPMCDAA_V100.lc')
    await expect(exportLotteWorkbook(f.tab, RANGE)).rejects.toThrow('history_page_required')
    f.navigate(HISTORY)
    auth.mockResolvedValue({ issuer: 'lotte_card', state: 'signed_out' })
    await expect(exportLotteWorkbook(f.tab, RANGE)).rejects.toThrow('authentication_required')
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('discards a returned workbook when navigation or authentication changes during export', async () => {
    const f = fixture()
    const response = (): Response => new Response(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    f.fetch.mockImplementationOnce(async () => {
      f.navigate('https://www.lottecard.co.kr/login')
      return response()
    })
    await expect(exportLotteWorkbook(f.tab, RANGE)).rejects.toThrow('navigation_changed')
    f.navigate(HISTORY)
    auth
      .mockReset()
      .mockResolvedValueOnce({ issuer: 'lotte_card', state: 'signed_in' })
      .mockResolvedValueOnce({ issuer: 'lotte_card', state: 'signed_out' })
    f.fetch.mockImplementationOnce(async () => response())
    await expect(exportLotteWorkbook(f.tab, RANGE)).rejects.toThrow('authentication_required')
  })

  it('accepts attachment HTML Excel but rejects a login HTML response and foreign redirect target', async () => {
    const f = fixture()
    f.fetch.mockResolvedValueOnce(
      new Response('<html><table><tr><td>synthetic</td></tr></table></html>', {
        headers: { 'content-disposition': 'attachment; filename="synthetic.xls"' }
      })
    )
    expect((await exportLotteWorkbook(f.tab, RANGE)).extension).toBe('xls')
    f.fetch.mockResolvedValueOnce(
      new Response('<html><form>synthetic-login</form></html>', {
        headers: { 'content-type': 'text/html' }
      })
    )
    await expect(exportLotteWorkbook(f.tab, RANGE)).rejects.toThrow('export_file_unrecognized')
    const response = new Response(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    Object.defineProperty(response, 'url', { value: 'https://example.invalid/export' })
    f.fetch.mockResolvedValueOnce(response)
    await expect(exportLotteWorkbook(f.tab, RANGE)).rejects.toThrow('export_response_unavailable')
  })

  it('bounds response size and sanitizes transport errors', async () => {
    const f = fixture()
    f.fetch.mockResolvedValueOnce(
      new Response('synthetic', { headers: { 'content-length': String(16 * 1024 * 1024 + 1) } })
    )
    await expect(exportLotteWorkbook(f.tab, RANGE)).rejects.toThrow('export_response_limit')
    f.fetch.mockRejectedValueOnce(new Error('synthetic-private-session-value'))
    await expect(exportLotteWorkbook(f.tab, RANGE)).rejects.toThrow(/^export_response_unavailable$/)
  })

  it('cancels a stalled request without returning private transport values', async () => {
    const f = fixture()
    const controller = new AbortController()
    f.fetch.mockImplementationOnce(async () => {
      controller.abort()
      return await new Promise(() => {})
    })
    await expect(exportLotteWorkbook(f.tab, RANGE, { signal: controller.signal })).rejects.toThrow(
      'export_cancelled'
    )
  })
})
