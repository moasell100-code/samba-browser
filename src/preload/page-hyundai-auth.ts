import type { HyundaiAuthSnapshot } from '../shared/hyundai-auth'
import { isVisible, labelTextOf, matchCaptchaSigns, ONE_TIME_PASSWORD_RE } from './login-detect'

function needsAdditionalAuth(): boolean {
  const parts: string[] = []
  const visit = (el: HTMLElement): void => {
    if (!isVisible(el) || /^(SCRIPT|STYLE|NOSCRIPT|INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3) parts.push(node.textContent ?? '')
      else if (node instanceof HTMLElement) visit(node)
    }
  }
  if (document.body) visit(document.body)
  const hasCodeInput = Array.from(document.querySelectorAll<HTMLInputElement>('input')).some(
    (el) =>
      isVisible(el) &&
      !el.disabled &&
      el.type !== 'hidden' &&
      ONE_TIME_PASSWORD_RE.test(labelTextOf(el))
  )
  const frameSources = Array.from(document.querySelectorAll('iframe'))
    .filter(isVisible)
    .map((el) => el.src || el.title)
  return matchCaptchaSigns({ text: parts.join(' ').slice(0, 20000), hasCodeInput, frameSources })
    .needsUser
}

// Hyundai's public index.jsp uses this exact form and PINsign mobile keypad.
// Do not infer a login PIN from arbitrary password fields or a payment keypad.
export function readHyundaiAuth(ensureId: (element: HTMLElement) => number): HyundaiAuthSnapshot {
  const url = new URL(document.URL)
  if (
    url.protocol !== 'https:' ||
    !['www.hyundaicard.com', 'hyundaicard.com'].includes(url.hostname) ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  )
    return { state: 'unsupported' }

  const visible = (selector: string): HTMLElement | null => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(isVisible)
    return elements.length === 1 ? elements[0] : null
  }
  const logout = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).some((el) => {
    if (!isVisible(el) || el.textContent?.trim() !== '로그아웃') return false
    try {
      const target = new URL(el.href, url)
      return target.origin === url.origin && target.pathname === '/cpm/mb/CPMMB0101_04.hc'
    } catch {
      return false
    }
  })
  if (logout) return { state: 'signed_in' }
  if (needsAdditionalAuth()) return { state: 'additional_auth' }

  // Unknown routes may include enrollment/change/payment forms. Never fill them.
  if (!['/', '/index.jsp', '/cpm/mb/CPMMB0101_01.hc'].includes(url.pathname)) {
    return { state: 'unknown' }
  }
  const error = visible('#id_pinErr')
  if (error?.textContent?.trim()) return { state: 'pin_error' }
  if (visible('#id_pin_area_not')) return { state: 'unsupported' }
  if (visible('#id_pin_area_yet')) return { state: 'registration_required' }
  const area = visible('#id_pin_area_input')
  const input = visible('#formPinLogin #inputPinPass')
  if (
    !area ||
    !(input instanceof HTMLInputElement) ||
    !area.contains(input) ||
    input.type !== 'password' ||
    input.maxLength !== 6 ||
    !input.readOnly ||
    input.disabled
  )
    return { state: 'unknown' }

  const snapshot: HyundaiAuthSnapshot = {
    state: 'pin_ready',
    inputId: ensureId(input),
    filled: input.value.length
  }
  // Ignore inputPinPassBg (always six stars), hidden templates, unrelated page digits.
  const container = visible('#mobile-pinpad #pinsign-pinpad-mobile-container')
  if (!container) return snapshot
  const keys = Array.from(
    container.querySelectorAll<HTMLElement>(
      '.pinsign-pinpad-body .pinsign-pinpad-number.pinpad-number'
    )
  ).filter(isVisible)
  const found = new Map<string, HTMLElement>()
  for (const key of keys) {
    const digit = key.textContent?.trim() ?? ''
    if (!/^\d$/.test(digit) || found.has(digit)) return snapshot
    found.set(digit, key)
  }
  if (found.size !== 10) return snapshot
  snapshot.digits = Array.from(found, ([digit, element]) => ({ digit, id: ensureId(element) }))
  return snapshot
}
