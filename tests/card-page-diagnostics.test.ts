import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { JSDOM } from 'jsdom'
import type { Tab } from '../src/main/browser/tab-manager'
import { pageBridge } from '../src/main/browser/page-bridge'
import {
  CARD_HISTORY_URLS,
  inspectCardPage,
  issuerForCardUrl,
  type CardPageStructure
} from '../src/main/finance/card-page-diagnostics'

const windows: JSDOM[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dom of windows.splice(0)) dom.window.close()
})

function fixture(
  url = CARD_HISTORY_URLS.samsung_card,
  html = ''
): {
  tab: Tab
  dom: JSDOM
  execute: ReturnType<typeof vi.fn>
  setUrl: (url: string) => void
} {
  let current = url
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' })
  windows.push(dom)
  const execute = vi.fn(async (code: string, gesture: boolean) => {
    expect(gesture).toBe(false)
    return dom.window.eval(code)
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
  return {
    tab,
    dom,
    execute,
    setUrl: (url) => {
      current = url
    }
  }
}

function signIn(issuer: 'hyundai_card' | 'samsung_card' | 'lotte_card'): {
  card: MockInstance<typeof pageBridge.cardSession>
  hyundai: MockInstance<typeof pageBridge.hyundaiAuth>
} {
  const card = vi.spyOn(pageBridge, 'cardSession').mockResolvedValue({ issuer, state: 'signed_in' })
  const hyundai = vi.spyOn(pageBridge, 'hyundaiAuth').mockResolvedValue({ state: 'signed_in' })
  return { card, hyundai }
}

describe('fixed read-only card history page diagnostics', () => {
  it('exports only the known history destinations and recognizes exact issuer login origins', () => {
    expect(Object.keys(CARD_HISTORY_URLS)).toEqual(['hyundai_card', 'samsung_card', 'lotte_card'])
    expect(issuerForCardUrl('https://www.lottecard.co.kr/app/LPMANAA_V200.lc')).toBe('lotte_card')
    expect(issuerForCardUrl('https://www.samsungcard.com/personal/login/UHPPCO0301M0.jsp')).toBe(
      'samsung_card'
    )
    expect(issuerForCardUrl('https://hyundaicard.com/cpa/ma/CPAMA0101_01.hc')).toBe('hyundai_card')
    for (const url of [
      'http://www.lottecard.co.kr/',
      'https://www.lottecard.co.kr.evil.test/',
      'https://www.lottecard.co.kr:8443/',
      'https://user@www.samsungcard.com/',
      'https://static12.samsungcard.com/',
      'https://evil.test/'
    ])
      expect(issuerForCardUrl(url)).toBeNull()
  })

  it.each(['hyundai_card', 'samsung_card', 'lotte_card'] as const)(
    'checks %s authentication before and after the fixed inspection',
    async (issuer) => {
      const auth = signIn(issuer)
      const f = fixture(
        CARD_HISTORY_URLS[issuer],
        '<form><input id="startDate" name="startDate"></form>'
      )
      const result = await inspectCardPage(f.tab)
      expect(result.state).toBe('ready')
      expect(result.issuer).toBe(issuer)
      expect(result.structure?.controls[0].name).toBe('startDate')
      expect(f.execute).toHaveBeenCalledOnce()
      expect(issuer === 'hyundai_card' ? auth.hyundai : auth.card).toHaveBeenCalledTimes(2)
      expect(issuer === 'hyundai_card' ? auth.card : auth.hyundai).not.toHaveBeenCalled()
    }
  )

  it('returns structure without form values, option values/text, page text, code, cookies or URL queries', async () => {
    signIn('samsung_card')
    const f = fixture(
      CARD_HISTORY_URLS.samsung_card + '?account=QUERY_SECRET',
      `
      <p>BODY_SECRET</p><form id="historyForm" name="historyForm" method="post" action="/frontservice/SHPPRP0801S51?token=ACTION_SECRET">
      <input id="start_day" name="inqrStrtdt" value="DATE_SECRET" onchange="return EVENT.searchHistory('ARG_SECRET')">
      <input id="row_123456" name="card_1234" type="hidden" value="HIDDEN_SECRET">
      <input type="password" value="PASSWORD_SECRET">
      <select id="fi_sl_cardchs" name="cardChoice"><option value="OPTION_SECRET">OPTION_TEXT_SECRET</option><option>OTHER_SECRET</option></select>
      <textarea name="memo">TEXTAREA_SECRET</textarea>
      <button type="button" onclick="EVENT.more('HANDLER_SECRET')">BUTTON_SECRET</button>
      </form>
      <script src="https://static12.samsungcard.com/js/personal/card/activity/UHPPRP0801D0.js?key=SCRIPT_SECRET#HASH_SECRET"></script>
      <script src="https://evil.test/private.js"></script>
      <script src="https://image.lottecard.co.kr/webapp/pc/js/p_script_LP.js"></script>
      <script>var privatePayload = 'INLINE_SECRET';
        function searchHistory() { window.fetch('/frontservice/SHPPRP0801S51?secret=REQUEST_SECRET'); }
        var EVENT = { selListFpyIstm: function() {}, submitPayment: function() {} };
        EVENT.more = function() {};
        var wrongOrigin = 'https://evil.test/frontservice/SHPPRP0801S12';
        var mutationPath = '/frontservice/SHPPPA0802U00';
      </script>
      <script type="application/json">{"fn":"function searchJsonSecret() {}"}</script>
    `
    )
    const fetch = vi.fn()
    Object.defineProperty(f.dom.window, 'fetch', { value: fetch })
    f.dom.window.document.cookie = 'test=COOKIE_SECRET'
    const before = f.dom.window.document.documentElement.outerHTML
    const result = await inspectCardPage(f.tab)
    expect(result.state).toBe('ready')
    const structure = result.structure!
    expect(structure.forms[0]).toMatchObject({
      actionPath: '/frontservice/SHPPRP0801S51',
      method: 'post',
      controlCount: 6
    })
    expect(structure.controls[0].handlers).toEqual(['EVENT.searchHistory'])
    expect(structure.controls[1]).toMatchObject({
      omittedId: true,
      omittedName: true,
      type: 'hidden',
      visible: false
    })
    expect(structure.controls[1].id).toBeUndefined()
    expect(structure.controls[3].optionCount).toBe(2)
    expect(structure.controls[5].handlers).toEqual(['EVENT.more'])
    expect(structure.scriptUrls).toEqual([
      'https://static12.samsungcard.com/js/personal/card/activity/UHPPRP0801D0.js'
    ])
    expect(structure.functionNames).toEqual(
      expect.arrayContaining(['searchHistory', 'selListFpyIstm', 'EVENT.more'])
    )
    expect(structure.functionNames).not.toContain('submitPayment')
    expect(structure.queryPaths).toEqual(['/frontservice/SHPPRP0801S51'])
    expect(JSON.stringify(result)).not.toMatch(
      /SECRET|privatePayload|submitPayment|searchJsonSecret|SHPPPA0802U00/
    )
    expect(fetch).not.toHaveBeenCalled()
    expect(f.dom.window.document.documentElement.outerHTML).toBe(before)
  })

  it.each(['/personal/card/activity/UHPPRP0801D0.jsp', '/personal/card/activity/UHPPRP0801D8.jsp'])(
    'allows the known Samsung history subpage %s',
    async (path) => {
      signIn('samsung_card')
      expect((await inspectCardPage(fixture('https://www.samsungcard.com' + path).tab)).state).toBe(
        'ready'
      )
    }
  )

  it('resolves relative form and script paths against the current history document', async () => {
    signIn('samsung_card')
    const f = fixture(
      CARD_HISTORY_URLS.samsung_card,
      '<form action="UHPPRP0801D8.jsp?token=PRIVATE_QUERY"></form><script src="history.js?token=PRIVATE_QUERY"></script>'
    )
    const result = await inspectCardPage(f.tab)
    expect(result.state).toBe('ready')
    expect(result.structure!.forms[0].actionPath).toBe('/personal/card/activity/UHPPRP0801D8.jsp')
    expect(result.structure!.scriptUrls).toEqual([
      'https://www.samsungcard.com/personal/card/activity/history.js'
    ])
    expect(JSON.stringify(result)).not.toContain('PRIVATE_QUERY')
  })

  it('reports expired sessions and does not inspect authenticated pages outside the history allowlist', async () => {
    const auth = signIn('samsung_card')
    auth.card.mockResolvedValue({ issuer: 'samsung_card', state: 'signed_out' })
    const login = fixture('https://www.samsungcard.com/personal/login/UHPPCO0301M0.jsp')
    expect((await inspectCardPage(login.tab)).state).toBe('signed_out')
    expect(login.execute).not.toHaveBeenCalled()
    auth.card.mockResolvedValue({ issuer: 'samsung_card', state: 'signed_in' })
    const other = fixture('https://www.samsungcard.com/personal/payment/private.jsp')
    expect((await inspectCardPage(other.tab)).state).toBe('not_history_page')
    expect(other.execute).not.toHaveBeenCalled()
    const unsupported = fixture('https://evil.test/')
    auth.card.mockClear()
    expect((await inspectCardPage(unsupported.tab)).state).toBe('unsupported')
    expect(auth.card).not.toHaveBeenCalled()
    expect(unsupported.execute).not.toHaveBeenCalled()
  })

  it('does not expose Hyundai PIN readiness details', async () => {
    const auth = signIn('hyundai_card')
    auth.hyundai.mockResolvedValue({
      state: 'pin_ready',
      inputId: 99,
      filled: 3,
      digits: [{ digit: '1', id: 88 }]
    })
    const f = fixture(CARD_HISTORY_URLS.hyundai_card)
    expect(await inspectCardPage(f.tab)).toEqual({
      issuer: 'hyundai_card',
      state: 'signed_out',
      auth: 'signed_out',
      historyUrl: CARD_HISTORY_URLS.hyundai_card
    })
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('discards diagnostics when the URL or signed-in state changes during inspection', async () => {
    const auth = signIn('lotte_card')
    const f = fixture(CARD_HISTORY_URLS.lotte_card)
    f.execute.mockImplementation(async (code: string) => {
      const result = f.dom.window.eval(code)
      f.setUrl(CARD_HISTORY_URLS.lotte_card + '?changed=1')
      return result
    })
    expect((await inspectCardPage(f.tab)).state).toBe('navigation_changed')
    auth.card
      .mockResolvedValueOnce({ issuer: 'lotte_card', state: 'signed_in' })
      .mockResolvedValueOnce({ issuer: 'lotte_card', state: 'signed_out' })
    const expired = await inspectCardPage(fixture(CARD_HISTORY_URLS.lotte_card).tab)
    expect(expired.state).toBe('signed_out')
    expect(expired.structure).toBeUndefined()
  })

  it('rejects tampered page output, cross-issuer paths and unexpected raw fields', async () => {
    signIn('samsung_card')
    for (const mutate of [
      (value: CardPageStructure) => ({ ...value, rawText: 'UNEXPECTED_SECRET' }),
      (value: CardPageStructure) => ({ ...value, issuer: 'lotte_card' }),
      (value: CardPageStructure) => ({ ...value, queryPaths: ['/frontservice/SHPPPA0802U00'] }),
      (value: CardPageStructure) => ({
        ...value,
        scriptUrls: ['https://static12.samsungcard.com/js/private.js?secret=value']
      }),
      (value: CardPageStructure) => ({
        ...value,
        scriptUrls: ['https://image.lottecard.co.kr/test.js']
      }),
      (value: CardPageStructure) => ({ ...value, functionNames: ['searchHistory(SECRET)'] })
    ]) {
      const f = fixture()
      f.execute.mockImplementation(async (code: string) => mutate(f.dom.window.eval(code)))
      const result = await inspectCardPage(f.tab)
      expect(result.state).toBe('invalid_result')
      expect(result.structure).toBeUndefined()
      expect(JSON.stringify(result)).not.toContain('SECRET')
    }
  })

  it('bounds collected controls and inline-source processing', async () => {
    signIn('samsung_card')
    const f = fixture(
      CARD_HISTORY_URLS.samsung_card,
      '<input name="startDate">'.repeat(201) +
        '<script>' +
        ' '.repeat(200001) +
        'function searchHiddenSecret(){}</script>'
    )
    const result = await inspectCardPage(f.tab)
    expect(result.state).toBe('ready')
    expect(result.structure!.controls).toHaveLength(200)
    expect(result.structure!.truncated).toBe(true)
    expect(result.structure!.functionNames).toEqual([])
  })

  it('does not return exception messages', async () => {
    signIn('samsung_card')
    const f = fixture()
    f.execute.mockRejectedValue(new Error('EXCEPTION_SECRET'))
    const result = await inspectCardPage(f.tab)
    expect(result.state).toBe('error')
    expect(JSON.stringify(result)).not.toContain('EXCEPTION_SECRET')
  })
})
