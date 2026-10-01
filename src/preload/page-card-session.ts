import type { CardSessionSnapshot } from '../shared/card-session'

// This isolated-world reader returns only fixed enums, never page text or form values.
function issuerOf(url: URL): CardSessionSnapshot['issuer'] {
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null
  switch (url.hostname) {
    case 'www.hyundaicard.com':
    case 'hyundaicard.com':
      return 'hyundai_card'
    case 'www.samsungcard.com':
      return 'samsung_card'
    case 'www.lottecard.co.kr':
      return 'lotte_card'
    default:
      return null
  }
}

function visible(el: Element): boolean {
  const view = el.ownerDocument.defaultView
  if (!view) return false
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return false
    if (node.hasAttribute('inert')) return false
    if (node.tagName === 'INPUT' && node.getAttribute('type') === 'hidden') return false
    const style = view.getComputedStyle(node)
    if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)) return false
    if (style.opacity !== '' && Number(style.opacity) === 0) return false
    if (style.clip === 'rect(0px, 0px, 0px, 0px)') return false
    if (
      style.position === 'absolute' &&
      (parseFloat(style.left) <= -9999 || parseFloat(style.top) <= -9999)
    )
      return false
  }
  return true
}

const ACTIONS = 'a,button,[role="link"],[role="button"]'
const LOTTE_LOGOUT_CALL =
  /^(?:javascript:\s*)?(?:return\s+)?fnDoLogout\s*\(\s*\)\s*;?\s*(?:return\s+false\s*;?)?$/

function hasLoginForm(doc: Document, issuer: NonNullable<CardSessionSnapshot['issuer']>): boolean {
  const selectors =
    issuer === 'hyundai_card'
      ? ['#formPinLogin #inputPinPass[type="password"]']
      : issuer === 'samsung_card'
        ? ['#npPfs #dgtlMmbrId', '#npPfs #pswde[type="password"]', '#btn_login']
        : ['#loginForm #mbrCtfDrmId', '#loginForm #mbrCtfEncV[type="password"]']
  return selectors.every((selector) => Array.from(doc.querySelectorAll(selector)).some(visible))
}

export function readCardSession(doc: Document = document): CardSessionSnapshot {
  let url: URL
  try {
    url = new URL(doc.URL)
  } catch {
    return { issuer: null, state: 'unsupported' }
  }
  const issuer = issuerOf(url)
  if (!issuer) return { issuer: null, state: 'unsupported' }
  const view = doc.defaultView
  if (!view || view.self !== view.top) return { issuer, state: 'unsupported' }
  if (hasLoginForm(doc, issuer)) return { issuer, state: 'signed_out' }

  const logout = Array.from(doc.querySelectorAll(ACTIONS)).some((el) => {
    if (!visible(el) || el.textContent?.trim() !== '로그아웃') return false
    if (issuer === 'samsung_card') return el.id === 'logoutBtn'
    if (issuer === 'lotte_card') {
      return ['href', 'onclick'].some((name) => LOTTE_LOGOUT_CALL.test(el.getAttribute(name) ?? ''))
    }
    if (el.tagName !== 'A') return false
    try {
      const target = new URL(el.getAttribute('href') ?? '', url)
      return (
        target.origin === url.origin &&
        !target.username &&
        !target.password &&
        target.pathname === '/cpm/mb/CPMMB0101_04.hc'
      )
    } catch {
      return false
    }
  })
  return { issuer, state: logout ? 'signed_in' : 'unknown' }
}
