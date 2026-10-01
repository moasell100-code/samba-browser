// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.hyundaicard.com/index.jsp"}
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  hyundaiAuth,
  installCaptureListener,
  pressOnce,
  resetElementIds
} from '../src/preload/page-core'

const form = `<div id="id_pin_area_input"><form id="formPinLogin"><input type="password" id="inputPinPassBg" value="******" readonly><input type="password" id="inputPinPass" maxlength="6" readonly></form><div id="mobile-pinpad"></div></div>`
function pad(digits = '0123456789'): string {
  return `<div id="pinsign-pinpad-mobile-container"><div class="pinsign-pinpad-body">${[...digits].map((digit) => `<div class="pinsign-pinpad-number pinpad-number">${digit}</div>`).join('')}</div></div>`
}
beforeEach(() => {
  history.replaceState(null, '', '/index.jsp')
  document.body.innerHTML = form
  resetElementIds()
})
describe('Hyundai PIN page adapter', () => {
  it('never captures the dummy PIN mask as a login password', () => {
    const send = vi.fn()
    installCaptureListener(send, { allowUntrusted: true })
    document.querySelector('#formPinLogin')!.dispatchEvent(new Event('submit', { bubbles: true }))
    expect(send).not.toHaveBeenCalled()
  })
  it('reads only real PIN mask length, never the dummy six-star input or secret', () => {
    const input = document.querySelector<HTMLInputElement>('#inputPinPass')!
    input.value = '***'
    const result = hyundaiAuth()
    expect(result.state).toBe('pin_ready')
    expect(result.filled).toBe(3)
    expect(JSON.stringify(result)).not.toContain('*')
    expect(result.digits).toBeUndefined()
  })
  it('requires the exact visible signed-in logout link, not a My Account heading', () => {
    document.body.innerHTML =
      '<h1>Account</h1><a href="/cpa/ma/CPAMA0101_01.hc">내 정보</a><a hidden href="/cpm/mb/CPMMB0101_04.hc">로그아웃</a>'
    expect(hyundaiAuth().state).toBe('unknown')
    document.querySelector('a[hidden]')!.removeAttribute('hidden')
    expect(hyundaiAuth()).toEqual({ state: 'signed_in' })
  })
  it('uses only all ten unique digits inside Hyundai mobile keypad', () => {
    document.querySelector('#mobile-pinpad')!.innerHTML = pad()
    document.body.insertAdjacentHTML('beforeend', '<button>1</button>')
    const result = hyundaiAuth()
    expect(result.digits).toHaveLength(10)
    let presses = 0
    document.querySelector('.pinpad-number')!.addEventListener('mousedown', () => presses++)
    pressOnce(result.digits![0].id)
    expect(presses).toBe(1)
    document.querySelector('#mobile-pinpad')!.innerHTML = pad('012345678')
    expect(hyundaiAuth().digits).toBeUndefined()
    document.querySelector('#mobile-pinpad')!.innerHTML = pad('01234567899')
    expect(hyundaiAuth().digits).toBeUndefined()
  })
  it('does not use hidden keypad or generic password forms', () => {
    document.querySelector('#mobile-pinpad')!.innerHTML = pad()
    document.querySelector<HTMLElement>('#mobile-pinpad')!.style.display = 'none'
    expect(hyundaiAuth().digits).toBeUndefined()
    document.querySelector('#inputPinPass')!.removeAttribute('readonly')
    expect(hyundaiAuth().state).toBe('unknown')
  })
  it('reports registration and PIN errors without carrying site error text', () => {
    document.body.innerHTML = '<div id="id_pin_area_yet">간편번호 등록</div>'
    expect(hyundaiAuth()).toEqual({ state: 'registration_required' })
    document.body.innerHTML = form + '<p id="id_pinErr">secret-like site error 000000</p>'
    expect(hyundaiAuth()).toEqual({ state: 'pin_error' })
  })
  it('hands visible OTP/captcha to user but ignores hidden templates and scripts', () => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div hidden>captcha<input name="otp"></div><script>captcha</script>'
    )
    expect(hyundaiAuth().state).toBe('pin_ready')
    document.body.insertAdjacentHTML('beforeend', '<div>문자 인증번호 입력<input name="otp"></div>')
    expect(hyundaiAuth()).toEqual({ state: 'additional_auth' })
  })
  it('never targets enrollment, password change or payment routes', () => {
    history.replaceState(null, '', '/cpm/mb/CPMMB0203_01.hc')
    expect(hyundaiAuth()).toEqual({ state: 'unknown' })
  })
})
