import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../src/main/browser/tab-manager'
import {
  inspectSamsungIdLogin,
  inspectSamsungLoginOutcome,
  prepareSamsungIdLogin
} from '../src/main/finance/samsung-login-preparation'

const LOGIN = 'https://www.samsungcard.com/personal/login/UHPPCO0301M0.jsp'
const windows: JSDOM[] = []
const HTML = `<a id="id_tab" href="#login02">아이디</a><form id="npPfs"><div id="login02" style="display:none"><input id="dgtlMmbrId" type="text"><input id="pswde" type="password"><button type="button" id="btn_login">로그인</button></div></form>`

function fixture(
  html = HTML,
  url = LOGIN
): {
  tab: Tab
  dom: JSDOM
  execute: ReturnType<typeof vi.fn>
  clicks: ReturnType<typeof vi.fn>
  submit: ReturnType<typeof vi.fn>
  changeUrl: (url: string) => void
} {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' })
  windows.push(dom)
  let current = url
  const clicks = vi.fn((event: Event) => {
    event.preventDefault()
    const panel = dom.window.document.querySelector<HTMLElement>('#login02')
    if (panel) panel.style.display = 'block'
  })
  dom.window.document.querySelector('#id_tab')?.addEventListener('click', clicks)
  const submit = vi.fn((event: Event) => event.preventDefault())
  dom.window.document.querySelector('form')?.addEventListener('submit', submit)
  dom.window.document.querySelector('#btn_login')?.addEventListener('click', submit)
  for (const input of dom.window.document.querySelectorAll('input')) {
    Object.defineProperty(input, 'value', {
      get() {
        throw new Error('PRIVATE_INPUT_VALUE_READ')
      },
      set() {
        throw new Error('PRIVATE_INPUT_VALUE_WRITE')
      }
    })
  }
  const execute = vi.fn((source: string, gesture: boolean) => {
    expect(gesture).toBe(false)
    return Promise.resolve(dom.window.eval(source))
  })
  const tab = {
    view: {
      webContents: { executeJavaScript: execute, getURL: () => current, isDestroyed: () => false }
    }
  } as unknown as Tab
  return {
    tab,
    dom,
    execute,
    clicks,
    submit,
    changeUrl: (value) => {
      current = value
    }
  }
}

afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Samsung visible alert outcome only', () => {
  it('ignores routine body instructions and hidden errors without reading input values', async () => {
    const f = fixture(
      HTML +
        '<p>보안프로그램 설치가 필요합니다. 추가 인증이 필요합니다.</p><div role="alert" hidden>아이디 또는 비밀번호를 잘못 입력하였습니다.</div>'
    )
    expect(await inspectSamsungLoginOutcome(f.tab)).toBe('unknown')
    expect(f.clicks).not.toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
  })

  it.each([
    ['아이디 또는 비밀번호를 잘못 입력하였습니다.', 'wrong_credentials'],
    ['비밀번호를 정확하게 입력해 주시기 바랍니다.', 'input_required'],
    ['보안프로그램 설치가 필요합니다.', 'security_program_required'],
    ['추가 인증이 필요합니다.', 'additional_auth'],
    ['보안문자를 입력해 주세요.', 'captcha']
  ])('returns fixed outcome only from a visible alert (%s)', async (message, outcome) => {
    const f = fixture(HTML + `<div role="alert">${message}<input value="PRIVATE_VALUE"></div>`)
    expect(await inspectSamsungLoginOutcome(f.tab)).toBe(outcome)
    expect(f.clicks).not.toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('does not classify hidden descendants or conflicting alert categories', async () => {
    const f = fixture(
      HTML +
        '<div role="alert">일시적 안내<span hidden>아이디 또는 비밀번호를 잘못 입력하였습니다.</span></div>'
    )
    expect(await inspectSamsungLoginOutcome(f.tab)).toBe('unknown')
    f.dom.window.document.querySelector('[role="alert"]')!.textContent =
      '아이디 또는 비밀번호를 잘못 입력하였습니다. 보안문자를 입력해 주세요.'
    expect(await inspectSamsungLoginOutcome(f.tab)).toBe('unknown')
  })

  it('guards the exact page and returns no arbitrary renderer errors or text', async () => {
    const f = fixture(HTML, 'https://other.test/')
    expect(await inspectSamsungLoginOutcome(f.tab)).toBe('unsupported')
    expect(f.execute).not.toHaveBeenCalled()
    f.changeUrl(LOGIN)
    f.execute.mockRejectedValueOnce(new Error('PRIVATE_PAGE_ERROR'))
    expect(await inspectSamsungLoginOutcome(f.tab)).toBe('unavailable')
  })
})

describe('Samsung public ID login tab preparation', () => {
  it('recognizes the dedicated official login page tab without an anchor ID', async () => {
    const f = fixture(
      HTML.replace(
        '<a id="id_tab" href="#login02">아이디</a>',
        '<ul class="ui_tab"><li id="ge_lgn_ctf_id"><a href="#login02">아이디</a></li></ul>'
      )
    )
    const target = f.dom.window.document.querySelector('#ge_lgn_ctf_id > a')!
    target.addEventListener('click', f.clicks)
    expect(await inspectSamsungIdLogin(f.tab)).toEqual({
      state: 'id_tab_available',
      tab: 'ge_lgn_ctf_id'
    })
    expect(await prepareSamsungIdLogin(f.tab)).toEqual({ state: 'ready', tab: 'ge_lgn_ctf_id' })
    expect(f.clicks).toHaveBeenCalledTimes(1)
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('rejects a duplicate hidden dedicated tab container', async () => {
    const f = fixture(
      HTML.replace(
        '<a id="id_tab" href="#login02">아이디</a>',
        '<li id="ge_lgn_ctf_id"><a href="#login02">아이디</a></li><li hidden id="ge_lgn_ctf_id"></li>'
      )
    )
    expect(await prepareSamsungIdLogin(f.tab)).toEqual({
      state: 'tab_unverified',
      tab: 'ge_lgn_ctf_id'
    })
    expect(f.clicks).not.toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('inspects the known hidden ID form without clicks, values, submit or raw DOM output', async () => {
    const f = fixture()
    expect(await inspectSamsungIdLogin(f.tab)).toEqual({ state: 'id_tab_available', tab: 'id_tab' })
    expect(f.clicks).not.toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
  })

  it.each(['아이디', '아이디 로그인', 'ID 로그인'])(
    'clicks the exact public ID tab once then confirms visible form (%s)',
    async (label) => {
      const f = fixture(HTML.replace('>아이디<', `>${label}<`))
      expect(await prepareSamsungIdLogin(f.tab)).toEqual({ state: 'ready', tab: 'id_tab' })
      expect(f.clicks).toHaveBeenCalledTimes(1)
      expect(f.submit).not.toHaveBeenCalled()
    }
  )

  it('does nothing when the ID form is already ready', async () => {
    const f = fixture(HTML.replace('display:none', 'display:block'))
    expect(await prepareSamsungIdLogin(f.tab)).toEqual({ state: 'ready', tab: 'id_tab' })
    expect(f.clicks).not.toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
  })

  it.each([
    'http://www.samsungcard.com/personal/login/UHPPCO0301M0.jsp',
    'https://www.samsungcard.com:444/personal/login/UHPPCO0301M0.jsp',
    'https://user@www.samsungcard.com/personal/login/UHPPCO0301M0.jsp',
    'https://www.samsungcard.com.evil.test/personal/login/UHPPCO0301M0.jsp',
    'https://www.samsungcard.com/personal/main/UHPPCO0101M0.jsp'
  ])('refuses all other contexts before evaluating (%s)', async (url) => {
    const f = fixture(HTML, url)
    expect(await prepareSamsungIdLogin(f.tab)).toEqual({ state: 'unsupported', tab: 'none' })
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.clicks).not.toHaveBeenCalled()
  })

  it('rechecks the real renderer URL independently of a stale main-process URL', async () => {
    const f = fixture(HTML, 'https://unrelated.test/')
    f.changeUrl(LOGIN)
    expect(await prepareSamsungIdLogin(f.tab)).toEqual({ state: 'unsupported', tab: 'none' })
    expect(f.clicks).not.toHaveBeenCalled()
  })

  it('refuses multiple visible matching tabs and never chooses the first', async () => {
    const f = fixture(HTML + '<button type="button">아이디 로그인</button>')
    expect(await prepareSamsungIdLogin(f.tab)).toEqual({ state: 'tab_ambiguous', tab: 'multiple' })
    expect(f.clicks).not.toHaveBeenCalled()
  })

  it.each([
    HTML.replace('href="#login02"', 'href="https://unrelated.test/"'),
    HTML.replace('id="id_tab"', 'id="unknown_tab"'),
    HTML.replace('>아이디<', '>아이디 찾기<'),
    HTML.replace('<a id="id_tab"', '<a style="position:absolute;left:-9999px" id="id_tab"'),
    HTML + '<a hidden id="id_tab" href="#login02">아이디</a>',
    HTML + '<input hidden type="password" id="pswde">'
  ])('does not click unknown, hidden, or duplicate structures (%#)', async (html) => {
    const f = fixture(html)
    expect((await prepareSamsungIdLogin(f.tab)).state).not.toBe('ready')
    expect(f.clicks).not.toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('does not click when the known inputs are outside the linked ID panel', async () => {
    const f = fixture(
      HTML.replace(
        '<div id="login02" style="display:none">',
        '<div id="login02"></div><div style="display:none">'
      )
    )
    expect(await prepareSamsungIdLogin(f.tab)).toEqual({ state: 'tab_unverified', tab: 'id_tab' })
    expect(f.clicks).not.toHaveBeenCalled()
  })

  it('waits for asynchronous panel display without repeatedly clicking', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const tab = f.dom.window.document.querySelector('#id_tab')!
    tab.removeEventListener('click', f.clicks)
    tab.addEventListener('click', (event) => {
      event.preventDefault()
      setTimeout(() => {
        f.dom.window.document.querySelector<HTMLElement>('#login02')!.style.display = 'block'
      }, 200)
    })
    const promise = prepareSamsungIdLogin(f.tab)
    await vi.advanceTimersByTimeAsync(300)
    expect(await promise).toEqual({ state: 'ready', tab: 'id_tab' })
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('returns only fixed failure metadata when clicking does not reveal the form', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.dom.window.document.querySelector('#id_tab')!.removeEventListener('click', f.clicks)
    f.dom.window.document
      .querySelector('#id_tab')!
      .addEventListener('click', (event) => event.preventDefault())
    const promise = prepareSamsungIdLogin(f.tab)
    await vi.advanceTimersByTimeAsync(2200)
    expect(await promise).toEqual({ state: 'tab_not_ready', tab: 'id_tab' })
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('refuses cancellation and navigation changes before selecting the tab', async () => {
    const f = fixture()
    expect(await prepareSamsungIdLogin(f.tab, { signal: AbortSignal.abort() })).toEqual({
      state: 'cancelled',
      tab: 'none'
    })
    expect(f.execute).not.toHaveBeenCalled()
    f.execute.mockImplementationOnce(() => {
      f.changeUrl('https://unrelated.test/')
      return Promise.resolve({ state: 'id_tab_available', tab: 'id_tab' })
    })
    expect(await prepareSamsungIdLogin(f.tab)).toEqual({ state: 'navigation_changed', tab: 'none' })
    expect(f.clicks).not.toHaveBeenCalled()
  })

  it('normalizes page failures without returning exception text or arbitrary result fields', async () => {
    const f = fixture()
    f.execute.mockRejectedValueOnce(new Error('PRIVATE_PAGE_TEXT'))
    expect(await inspectSamsungIdLogin(f.tab)).toEqual({ state: 'unavailable', tab: 'none' })
    f.execute.mockResolvedValueOnce({ state: 'ready', tab: 'id_tab', private: 'PRIVATE_PAGE_TEXT' })
    expect(await inspectSamsungIdLogin(f.tab)).toEqual({ state: 'unavailable', tab: 'none' })
  })
})
