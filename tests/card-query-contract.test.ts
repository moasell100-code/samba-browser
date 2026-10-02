import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../src/main/browser/tab-manager'
import { inspectCardPage } from '../src/main/finance/card-page-diagnostics'
import { inspectCardQueryContract } from '../src/main/finance/card-query-contract'

vi.mock('../src/main/finance/card-page-diagnostics', () => ({ inspectCardPage: vi.fn() }))
const windows: JSDOM[] = []
const URL = 'https://www.lottecard.co.kr/app/LPMCDAA_V100.lc'
afterEach(() => {
  vi.resetAllMocks()
  for (const dom of windows.splice(0)) dom.window.close()
})

function fixture(source = ''): {
  tab: Tab
  dom: JSDOM
  execute: ReturnType<typeof vi.fn>
  setUrl: (value: string) => void
} {
  let current = URL
  const dom = new JSDOM(
    '<input id="searchValue" value="FORM_PRIVATE_VALUE"><button id="searchFilterBtn"></button>',
    { url: URL, runScripts: 'outside-only' }
  )
  windows.push(dom)
  if (source) {
    const script = dom.window.document.createElement('script')
    script.textContent = source
    dom.window.document.body.append(script)
    dom.window.eval(source)
  }
  const execute = vi.fn((script: string, gesture: boolean) => {
    expect(gesture).toBe(false)
    return dom.window.eval(script)
  })
  const tab = {
    view: {
      webContents: {
        getURL: () => current,
        isDestroyed: () => false,
        executeJavaScript: execute
      }
    }
  } as unknown as Tab
  vi.mocked(inspectCardPage).mockResolvedValue({
    issuer: 'lotte_card',
    state: 'ready',
    auth: 'signed_in'
  })
  return { tab, dom, execute, setUrl: (value) => (current = value) }
}

describe('fixed query contract inspection redaction', () => {
  it('does not invoke query functions or read form values', async () => {
    const f = fixture(`function fnSearch() {
      window.didQuery = true;
      return document.getElementById('searchValue').value;
    }`)
    const control = f.dom.window.document.querySelector('input')!
    const valueRead = vi.fn(() => {
      throw new Error('form value must not be read')
    })
    Object.defineProperty(control, 'value', { get: valueRead })
    const result = await inspectCardQueryContract(f.tab)
    expect(JSON.stringify(result)).not.toContain('FORM_PRIVATE_VALUE')
    expect(valueRead).not.toHaveBeenCalled()
    expect((f.dom.window as unknown as Record<string, unknown>).didQuery).toBeUndefined()
    expect(JSON.stringify(result)).toContain('fnSearch')
  })

  it('removes short literals, comments and identifiers supplied as string data', async () => {
    const f = fixture(`function fnSearch() {
      // COMMENT_PRIVATE_VALUE
      const customer = 'SHORT_TOKEN';
      const name = "PRIVATE_NAME";
      const account = 'abc123';
      /* BLOCK_PRIVATE_VALUE */
      return { customer, name, account, pageNo: 1 };
    }`)
    const serialized = JSON.stringify(await inspectCardQueryContract(f.tab))
    for (const secret of [
      'COMMENT_PRIVATE_VALUE',
      'SHORT_TOKEN',
      'PRIVATE_NAME',
      'abc123',
      'BLOCK_PRIVATE_VALUE'
    ])
      expect(serialized).not.toContain(secret)
    expect(serialized).toContain('fnSearch')
  })

  it('redacts escaped quotes and nested template expressions without leaking residual literals', async () => {
    const f = fixture(
      String.raw`function fnSearch() {
      const one = 'prefix\'ESCAPED_PRIVATE_VALUE';
      const two = "prefix\"DOUBLE_PRIVATE_VALUE";
      const three = ` +
        '`TEMPLATE_PRIVATE_VALUE ${ true ? "NESTED_PRIVATE_VALUE" : `INNER_PRIVATE_VALUE` } END_PRIVATE_VALUE`' +
        String.raw`;
      return [one, two, three];
    }`
    )
    const serialized = JSON.stringify(await inspectCardQueryContract(f.tab))
    for (const secret of [
      'ESCAPED_PRIVATE_VALUE',
      'DOUBLE_PRIVATE_VALUE',
      'TEMPLATE_PRIVATE_VALUE',
      'NESTED_PRIVATE_VALUE',
      'INNER_PRIVATE_VALUE',
      'END_PRIVATE_VALUE'
    ])
      expect(serialized).not.toContain(secret)
  })

  it('retains public region/currency comparisons while redacting unrelated short string data', async () => {
    const f = fixture(`function fnSearch(li) {
      const currency = li.acplCrncCd === 'KRW';
      const region = 'F' === li.dmfrClsf;
      const customer = 'PRIVATE';
      return [currency, region, customer];
    }`)
    const serialized = JSON.stringify(await inspectCardQueryContract(f.tab))
    expect(serialized).toContain('KRW')
    expect(serialized).toContain('F')
    expect(serialized).not.toContain('PRIVATE')
  })

  it('inspects a static Hyundai card selector initializer without executing it', async () => {
    const f = fixture(`function setCardSelector(vldCardList) {
      window.didInitialize = true;
      return vldCardList.map(card => card.crno + 'PRIVATE_CARD_NAME');
    }`)
    const url = 'https://www.hyundaicard.com/cpa/cb/CPACB0101_01.hc'
    f.setUrl(url)
    f.dom.reconfigure({ url })
    vi.mocked(inspectCardPage).mockResolvedValue({
      issuer: 'hyundai_card',
      state: 'ready',
      auth: 'signed_in'
    })
    const serialized = JSON.stringify(await inspectCardQueryContract(f.tab))
    expect(serialized).toContain('setCardSelector')
    expect(serialized).not.toContain('PRIVATE_CARD_NAME')
    expect((f.dom.window as unknown as Record<string, unknown>).didInitialize).toBeUndefined()
  })

  it('projects only fixed public unit text from static markup without returning attributes', async () => {
    const f = fixture(`function fnSearch() {
      const unit = '<span class="PRIVATE_ATTRIBUTE">원</span>';
      const customer = '<span>PRIVATE_CUSTOMER</span>';
      return [unit, customer];
    }`)
    const serialized = JSON.stringify(await inspectCardQueryContract(f.tab))
    expect(serialized).toContain('[markup omitted]원')
    expect(serialized).not.toContain('PRIVATE_ATTRIBUTE')
    expect(serialized).not.toContain('PRIVATE_CUSTOMER')
  })

  it('does not invoke accessor properties or event handlers while inspecting', async () => {
    const f = fixture()
    const getter = vi.fn(() => {
      throw new Error('must not access')
    })
    Object.defineProperty(f.dom.window, 'fnSearch', { get: getter })
    f.dom.window.eval(
      `window.readHandler = function () { window.handlerRan = true; return 'HANDLER_PRIVATE_VALUE'; }`
    )
    Object.assign(f.dom.window, {
      jQuery: {
        _data: () => ({
          click: [{ handler: (f.dom.window as unknown as Record<string, unknown>).readHandler }]
        })
      }
    })
    const serialized = JSON.stringify(await inspectCardQueryContract(f.tab))
    expect(getter).not.toHaveBeenCalled()
    expect((f.dom.window as unknown as Record<string, unknown>).handlerRan).toBeUndefined()
    expect(serialized).not.toContain('HANDLER_PRIVATE_VALUE')
  })

  it('does not inspect an unauthenticated or unsupported page', async () => {
    const f = fixture()
    vi.mocked(inspectCardPage).mockResolvedValue({
      issuer: 'lotte_card',
      state: 'signed_out',
      auth: 'signed_out'
    })
    const result = await inspectCardQueryContract(f.tab)
    expect(result).toEqual({ state: 'signed_out', auth: 'signed_out' })
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('checks the exact origin inside the inspection before reading scripts', async () => {
    const f = fixture()
    f.dom.reconfigure({ url: 'https://www.lottecard.co.kr.evil.test/app/LPMCDAA_V100.lc' })
    const scriptsRead = vi.fn(() => [])
    Object.defineProperty(f.dom.window.document, 'scripts', { get: scriptsRead })
    await inspectCardQueryContract(f.tab)
    expect(scriptsRead).not.toHaveBeenCalled()
  })
})
