import { afterEach, describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { readCardSession } from '../src/preload/page-card-session'

const windows: JSDOM[] = []
function at(url: string, html: string): Document {
  const dom = new JSDOM(html, { url })
  windows.push(dom)
  return dom.window.document
}
afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close()
})

const sites = [
  {
    url: 'https://www.hyundaicard.com/index.jsp',
    issuer: 'hyundai_card',
    logout: '<a href="/cpm/mb/CPMMB0101_04.hc">로그아웃</a>',
    login: '<form id="formPinLogin"><input type="password" id="inputPinPass"></form>'
  },
  {
    url: 'https://www.samsungcard.com/personal/main/UHPPCO0101M0.jsp',
    issuer: 'samsung_card',
    logout: '<button id="logoutBtn">로그아웃</button>',
    login:
      '<form id="npPfs"><input id="dgtlMmbrId"><input type="password" id="pswde"><button id="btn_login" type="button">로그인</button></form>'
  },
  {
    url: 'https://www.lottecard.co.kr/app/LPMCDAA_V100.lc',
    issuer: 'lotte_card',
    logout: '<a href="javascript:fnDoLogout();">로그아웃</a>',
    login:
      '<form id="loginForm"><input id="mbrCtfDrmId"><input type="password" id="mbrCtfEncV"></form>'
  }
] as const

describe('fixed card session reader', () => {
  it.each(sites)('requires the visible official logout action for $issuer', (site) => {
    expect(readCardSession(at(site.url, site.logout))).toEqual({
      issuer: site.issuer,
      state: 'signed_in'
    })
    expect(readCardSession(at(site.url, '<p>마이페이지 내 정보 로그아웃</p>'))).toEqual({
      issuer: site.issuer,
      state: 'unknown'
    })
  })

  it.each(sites)('does not mistake hidden logout templates for $issuer sessions', (site) => {
    for (const attribute of ['hidden', 'aria-hidden="true"', 'style="display:none"', 'inert']) {
      expect(readCardSession(at(site.url, `<div ${attribute}>${site.logout}</div>`)).state).toBe(
        'unknown'
      )
    }
  })

  it.each(sites)('treats a visible official login form as signed out for $issuer', (site) => {
    expect(readCardSession(at(site.url, site.login + site.logout))).toEqual({
      issuer: site.issuer,
      state: 'signed_out'
    })
    expect(
      readCardSession(at(site.url, `<div hidden>${site.login}</div>${site.logout}`)).state
    ).toBe('signed_in')
  })

  it.each([
    'http://www.hyundaicard.com/',
    'https://www.hyundaicard.com:8443/',
    'https://www.samsungcard.com.evil.test/',
    'https://samsungcard.com/',
    'https://lottecard.co.kr/',
    'https://login.lottecard.co.kr/',
    'https://user:secret@www.lottecard.co.kr/',
    'file:///www.lottecard.co.kr/'
  ])('rejects origins outside the exact secure allowlist: %s', (url) => {
    expect(readCardSession(at(url, sites.map((site) => site.logout).join('')))).toEqual({
      issuer: null,
      state: 'unsupported'
    })
  })

  it('accepts only the exact Hyundai logout path on the same origin', () => {
    for (const href of [
      '/other/logout',
      'https://other.hyundaicard.com/cpm/mb/CPMMB0101_04.hc',
      'https://user:secret@www.hyundaicard.com/cpm/mb/CPMMB0101_04.hc'
    ]) {
      expect(readCardSession(at(sites[0].url, `<a href="${href}">로그아웃</a>`)).state).toBe(
        'unknown'
      )
    }
    expect(readCardSession(at('https://hyundaicard.com/', sites[0].logout)).state).toBe('signed_in')
  })

  it('does not infer Samsung login from a function string or another logout button', () => {
    const doc = at(
      sites[1].url,
      '<script>$("#logoutBtn").click(logout)</script><button>로그아웃</button><div id="logoutBtn">로그아웃</div>'
    )
    expect(readCardSession(doc).state).toBe('unknown')
  })

  it.each([
    'javascript:scard.gnb.logout_popup()',
    'javascript: scard.gnb.logout_popup();',
    'scard.gnb.logout_popup( );'
  ])('recognizes the exact visible Samsung header logout link: %s', (href) => {
    const html = `<a href="${href}"><span>로그아웃</span></a>`
    expect(readCardSession(at(sites[1].url, html))).toEqual({
      issuer: 'samsung_card',
      state: 'signed_in'
    })
    expect(readCardSession(at(sites[1].url, `<div hidden>${html}</div>`)).state).toBe('unknown')
    expect(readCardSession(at(sites[1].url, sites[1].login + html)).state).toBe('signed_out')
  })

  it.each([
    "javascript:show('scard.gnb.logout_popup()')",
    'javascript:other.scard.gnb.logout_popup()',
    'javascript:scard.gnb.logout_popup_preview()',
    'javascript:scard.gnb.logout_popup(1)',
    'javascript:scard.gnb.logout_popup();runMore()',
    'javascript:scard.gnb.logout_popup();return false;',
    'https://evil.test/?action=scard.gnb.logout_popup()'
  ])('rejects unverified Samsung link actions: %s', (href) => {
    const doc = at(sites[1].url, '<a>로그아웃</a>')
    doc.querySelector('a')!.setAttribute('href', href)
    expect(readCardSession(doc).state).toBe('unknown')
  })

  it('does not accept a Samsung logout function on an unrelated control or with a different label', () => {
    expect(
      readCardSession(
        at(
          sites[1].url,
          '<button onclick="scard.gnb.logout_popup()">로그아웃</button><a href="javascript:scard.gnb.logout_popup()">로그인</a>'
        )
      ).state
    ).toBe('unknown')
  })

  it('requires a real Lotte logout call rather than quoted text or a related function', () => {
    for (const onclick of [
      "show('fnDoLogout()')",
      'other.fnDoLogout()',
      'fnDoLogoutPreview()',
      'fnDoLogout("account")'
    ]) {
      const doc = at(sites[2].url, '<button>로그아웃</button>')
      doc.querySelector('button')!.setAttribute('onclick', onclick)
      expect(readCardSession(doc).state).toBe('unknown')
    }
    expect(
      readCardSession(
        at(sites[2].url, '<button onclick="fnDoLogout(); return false;">로그아웃</button>')
      ).state
    ).toBe('signed_in')
  })

  it.each([
    "GA_BtnEvent('HEADER','UTILTY',this); fnDoLogout(); return false;",
    ' GA_BtnEvent( "HEADER", "UTILTY", this ); fnDoLogout( ); ',
    "GA_BtnEvent('HEADER','UTILTY',this);fnDoLogout()"
  ])(
    'recognizes only the exact visible Lotte header tracking-plus-logout action: %s',
    (onclick) => {
      const doc = at(sites[2].url, '<a href="#">로그아웃</a>')
      doc.querySelector('a')!.setAttribute('onclick', onclick)
      expect(readCardSession(doc)).toEqual({ issuer: 'lotte_card', state: 'signed_in' })
      doc.querySelector('a')!.setAttribute('hidden', '')
      expect(readCardSession(doc).state).toBe('unknown')
      doc.querySelector('a')!.removeAttribute('hidden')
      doc.body.insertAdjacentHTML('beforeend', sites[2].login)
      expect(readCardSession(doc).state).toBe('signed_out')
    }
  )

  it.each([
    "GA_BtnEvent('HEADER','UTILTY',this); show('fnDoLogout()');",
    "GA_BtnEvent('HEADER','UTILTY',this); fnDoLogoutPreview();",
    "GA_BtnEvent('HEADER','UTILTY',this); other.fnDoLogout();",
    "GA_BtnEvent('HEADER','UTILTY',this); fnDoLogout('account');",
    "GA_BtnEvent('HEADER','UTILTY',this); fnDoLogout(); runMore();",
    "GA_BtnEvent('HEADER','UTILTY',getTarget()); fnDoLogout();",
    "GA_BtnEvent('HEADER','UTILTY',this.value); fnDoLogout();",
    "GA_BtnEvent('HEADER','UTILTY','this'); fnDoLogout();",
    "GA_BtnEvent('HEADER','UTILTY',this, 'fnDoLogout()');",
    "GA_BtnEvent('FOOTER','CNT',this); fnDoLogout();",
    "GA_BtnEvent(category,'UTILTY',this); fnDoLogout();",
    "GA_BtnEvent('HEADER','UTILTY',this); if (false) fnDoLogout();"
  ])('rejects broader or quoted Lotte tracking wrappers: %s', (onclick) => {
    const doc = at(sites[2].url, '<a href="#">로그아웃</a>')
    doc.querySelector('a')!.setAttribute('onclick', onclick)
    expect(readCardSession(doc).state).toBe('unknown')
  })

  it('restricts the tracked Lotte logout marker to the observed anchor and label', () => {
    const action = "GA_BtnEvent('HEADER','UTILTY',this); fnDoLogout(); return false;"
    for (const html of [
      '<button>로그아웃</button>',
      '<a href="/other">로그아웃</a>',
      '<a href="#">로그인</a>'
    ]) {
      const doc = at(sites[2].url, html)
      doc.body.firstElementChild!.setAttribute('onclick', action)
      expect(readCardSession(doc).state).toBe('unknown')
    }
  })

  it('never returns input values, body text, account labels or page URLs', () => {
    const doc = at(
      `${sites[2].url}?account=private-account`,
      `${sites[2].logout}<input value="private-secret"><p>private-body</p>`
    )
    expect(readCardSession(doc)).toEqual({ issuer: 'lotte_card', state: 'signed_in' })
  })

  it('refuses an embedded frame even when it contains a logout control', () => {
    const doc = at(sites[1].url, '<iframe></iframe>')
    const child = doc.querySelector('iframe')!.contentDocument!
    child.body.innerHTML = sites[1].logout
    Object.defineProperty(child, 'URL', { value: sites[1].url })
    expect(readCardSession(child)).toEqual({ issuer: 'samsung_card', state: 'unsupported' })
  })
})
