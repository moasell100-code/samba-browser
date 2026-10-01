import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { focusLottePassword, readLotteAuth, submitLotteLogin } from '../src/preload/page-lotte-auth'

const form = `<form id="loginForm"><fieldset class="idLogin"><input id="mbrCtfDrmId"><input id="mbrCtfEncV" name="mbrCtfEncV" type="password" maxlength="20" npkencrypt="on" data-keypad-type="alpha" data-input-useyn-type="toggle"><button type="button" onclick="fnDoLoginId(); return false;">로그인</button></fieldset></form>`
const windows: JSDOM[] = []
function at(html = form, url = 'https://www.lottecard.co.kr/app/LPMANAA_V200.lc'): Document {
  const dom = new JSDOM(html, { url })
  windows.push(dom)
  return dom.window.document
}
afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close()
})

describe('Lotte protected password input diagnostic', () => {
  it('reads only fixed state, focus and length; never input or hidden encryption values', () => {
    const doc = at()
    const input = doc.querySelector<HTMLInputElement>('#mbrCtfEncV')!
    input.value = 'synthetic-fixture'
    doc.body.insertAdjacentHTML(
      'beforeend',
      '<input type="hidden" name="encryption" value="private">'
    )
    expect(readLotteAuth(doc)).toEqual({ state: 'keyboard_ready', focused: false, filled: 17 })
  })
  it('stops before focus when the official secure keypad is required', () => {
    const doc = at()
    const input = doc.querySelector<HTMLInputElement>('#mbrCtfEncV')!
    input.readOnly = true
    const focused = vi.fn()
    input.addEventListener('focus', focused)
    expect(focusLottePassword(doc)).toEqual({ state: 'keypad_required' })
    expect(focused).not.toHaveBeenCalled()
    expect(input.readOnly).toBe(true)
  })
  it('detects focus handlers that switch the field to the official keypad', () => {
    const doc = at()
    const input = doc.querySelector<HTMLInputElement>('#mbrCtfEncV')!
    input.addEventListener('focus', () => {
      input.readOnly = true
    })
    expect(focusLottePassword(doc)).toEqual({ state: 'keypad_required' })
  })
  it('waits for the security script to initialize without changing its attributes', () => {
    const doc = at()
    doc.querySelector('input[type=password]')!.removeAttribute('data-input-useyn-type')
    expect(readLotteAuth(doc)).toEqual({ state: 'initializing' })
    expect(focusLottePassword(doc)).toEqual({ state: 'initializing' })
  })
  it('requires the exact secure login route and visible official field structure', () => {
    for (const url of [
      'http://www.lottecard.co.kr/app/LPMANAA_V200.lc',
      'https://www.lottecard.co.kr:8443/app/LPMANAA_V200.lc',
      'https://other.lottecard.co.kr/app/LPMANAA_V200.lc'
    ]) {
      expect(readLotteAuth(at(form, url)).state).toBe('unsupported')
    }
    expect(readLotteAuth(at(form, 'https://www.lottecard.co.kr/app/LPMCDCB_V100.lc')).state).toBe(
      'unknown'
    )
    expect(readLotteAuth(at(`<div hidden>${form}</div>`)).state).toBe('unknown')
    expect(readLotteAuth(at(form.replace('npkencrypt="on"', ''))).state).toBe('unknown')
  })
  it('reports a visible E0010 error without copying its surrounding message', () => {
    expect(
      readLotteAuth(
        at(form + '<div class="alertBox"><p class="alertMsg">private E0010 message</p></div>')
      )
    ).toEqual({ state: 'input_error' })
    expect(
      readLotteAuth(at(form + '<div hidden class="alertBox"><p class="alertMsg">E0010</p></div>'))
        .state
    ).toBe('keyboard_ready')
  })
  it('submits once through the official click handler only when length and mode match', () => {
    const doc = at()
    const input = doc.querySelector<HTMLInputElement>('#mbrCtfEncV')!
    const click = vi.fn()
    doc.querySelector('button')!.addEventListener('click', click)
    input.value = 'fixture'
    expect(submitLotteLogin(6, doc)).toBe(false)
    expect(submitLotteLogin(7, doc)).toBe(true)
    input.readOnly = true
    expect(submitLotteLogin(7, doc)).toBe(false)
    expect(click).toHaveBeenCalledOnce()
  })
})
