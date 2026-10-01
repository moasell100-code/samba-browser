import type { LotteAuthSnapshot } from '../shared/lotte-auth'
import { readCardSession } from './page-card-session'

export function visibleLotteElement(el: Element): boolean {
  const view = el.ownerDocument.defaultView
  if (!view) return false
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return false
    if (node.hasAttribute('inert')) return false
    if (node.tagName === 'INPUT' && node.getAttribute('type') === 'hidden') return false
    const style = view.getComputedStyle(node)
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse'
    )
      return false
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

export function lottePasswordField(doc: Document): HTMLInputElement | null {
  const candidates = Array.from(
    doc.querySelectorAll<HTMLInputElement>('#loginForm .idLogin #mbrCtfEncV')
  ).filter(visibleLotteElement)
  if (candidates.length !== 1) return null
  const input = candidates[0]
  if (
    input.type !== 'password' ||
    input.name !== 'mbrCtfEncV' ||
    input.maxLength !== 20 ||
    input.disabled ||
    input.getAttribute('npkencrypt') !== 'on' ||
    input.getAttribute('data-keypad-type') !== 'alpha'
  )
    return null
  return input
}

export function readLotteAuth(doc: Document = document): LotteAuthSnapshot {
  const session = readCardSession(doc)
  if (session.issuer !== 'lotte_card' || session.state === 'unsupported')
    return { state: 'unsupported' }
  if (session.state === 'signed_in') return { state: 'signed_in' }
  if (new URL(doc.URL).pathname !== '/app/LPMANAA_V200.lc') return { state: 'unknown' }
  const error = Array.from(doc.querySelectorAll('.alertBox .alertMsg')).some(
    (el) => visibleLotteElement(el) && /E0010|보안키패드\s*입력\s*오류/.test(el.textContent ?? '')
  )
  if (error) return { state: 'input_error' }
  const input = lottePasswordField(doc)
  if (!input) return { state: 'unknown' }
  // nProtect requires its own keypad if the supported keyboard security client is unavailable.
  // Never clear readonly or write its hidden encryption fields to force another input mode.
  if (input.readOnly) return { state: 'keypad_required' }
  if (input.getAttribute('data-input-useyn-type') !== 'toggle') return { state: 'initializing' }
  return {
    state: 'keyboard_ready',
    focused: doc.activeElement === input,
    filled: input.value.length
  }
}

export function focusLottePassword(doc: Document = document): LotteAuthSnapshot {
  const before = readLotteAuth(doc)
  if (before.state !== 'keyboard_ready') return before
  lottePasswordField(doc)!.focus()
  // Focus handlers can activate the official mandatory keypad and change readonly.
  return readLotteAuth(doc)
}

export function submitLotteLogin(expectedLength: number, doc: Document = document): boolean {
  const state = readLotteAuth(doc)
  if (
    state.state !== 'keyboard_ready' ||
    !Number.isInteger(expectedLength) ||
    expectedLength < 1 ||
    expectedLength > 20 ||
    state.filled !== expectedLength
  )
    return false
  const buttons = Array.from(
    doc.querySelectorAll<HTMLButtonElement>('#loginForm .idLogin button[type="button"]')
  ).filter(
    (el) =>
      visibleLotteElement(el) &&
      !el.disabled &&
      el.textContent?.trim() === '로그인' &&
      /^fnDoLoginId\(\);\s*return false;?$/.test(el.getAttribute('onclick') ?? '')
  )
  if (buttons.length !== 1) return false
  buttons[0].click()
  return true
}
