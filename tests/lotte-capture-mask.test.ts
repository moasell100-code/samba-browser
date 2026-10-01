// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.lottecard.co.kr/app/LPMANAA_V200.lc"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installCaptureListener } from '../src/preload/page-core'

beforeEach(() => {
  history.replaceState(null, '', '/app/LPMANAA_V200.lc')
  document.body.innerHTML = `<form id="loginForm"><fieldset class="idLogin">
    <input id="mbrCtfDrmId" value="synthetic-user">
    <input type="password" id="mbrCtfEncV" name="mbrCtfEncV" maxlength="20"
      npkencrypt="on" data-keypad-type="alpha" value="*******">
    <button type="button">로그인</button>
  </fieldset></form>`
})

afterEach(() => vi.restoreAllMocks())

describe('Lotte protected password capture exclusion', () => {
  it.each([true, false])('does not read or send a protected mask with readonly=%s', (readOnly) => {
    const password = document.querySelector<HTMLInputElement>('#mbrCtfEncV')!
    password.readOnly = readOnly
    const value = vi.spyOn(password, 'value', 'get')
    const send = vi.fn()
    // Synthetic events stand in for the user's trusted submit/click at this listener boundary.
    installCaptureListener(send, { allowUntrusted: true })
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true }))
    document.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(value).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('preserves ordinary password capture on the same site', () => {
    const password = document.querySelector<HTMLInputElement>('#mbrCtfEncV')!
    password.id = 'ordinaryPassword'
    password.removeAttribute('npkencrypt')
    password.removeAttribute('data-keypad-type')
    password.value = 'synthetic-password'
    const send = vi.fn()
    installCaptureListener(send, { allowUntrusted: true })
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true }))
    expect(send).toHaveBeenCalledWith({
      host: 'www.lottecard.co.kr',
      username: 'synthetic-user',
      password: 'synthetic-password'
    })
  })

  it('limits the known protected-field exclusion to the verified login route', () => {
    history.replaceState(null, '', '/unrelated-form')
    const password = document.querySelector<HTMLInputElement>('#mbrCtfEncV')!
    password.value = 'synthetic-password'
    const send = vi.fn()
    installCaptureListener(send, { allowUntrusted: true })
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true }))
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ password: 'synthetic-password' }))
  })
})
