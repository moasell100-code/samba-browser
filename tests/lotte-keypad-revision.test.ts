// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.lottecard.co.kr/app/LPMANAA_V200.lc"}
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { lotteKeypad, pressLotteKeypad, eraseLotteKeypadProbe } from '../src/preload/page-core'

beforeEach(() => {
  document.body.innerHTML = `<form id="loginForm"><fieldset class="idLogin"><input id="mbrCtfDrmId"><input id="mbrCtfEncV" name="mbrCtfEncV" type="password" maxlength="20" npkencrypt="on" data-keypad-type="alpha" readonly><button type="button" id="mbrCtfEncV_keypad">보안키패드 열기</button></fieldset><div id="nppfs-keypad-mbrCtfEncV"><div class="kpd-group lower"><img class="kpd-data" role="button" alt="소문자 a" aria-label="소문자 a"><img class="kpd-data" role="button" alt="한개지움" aria-label="한개지움"></div></div></form>`
})
describe('fresh Lotte public layout revision', () => {
  it('presses one public key only once when count and full layout remain unchanged', () => {
    const before = lotteKeypad()
    const click = vi.fn()
    document.querySelector('img')!.addEventListener('click', click)
    expect(lotteKeypad().layout).toBe(before.layout)
    expect(pressLotteKeypad(before.keys![0].id, 0, before.layout!)).toBe('ok')
    expect(click).toHaveBeenCalledOnce()
  })
  it('refuses a same-node shuffle that changes the public character while keeping its registry id', () => {
    const before = lotteKeypad()
    const key = document.querySelector('img')!
    const click = vi.fn()
    key.addEventListener('click', click)
    key.setAttribute('alt', '소문자 b')
    key.setAttribute('aria-label', '소문자 b')
    const after = lotteKeypad()
    expect(after.keys![0].id).toBe(before.keys![0].id)
    expect(after.layout).not.toBe(before.layout)
    expect(pressLotteKeypad(before.keys![0].id, 0, before.layout!)).toContain('refused')
    expect(click).not.toHaveBeenCalled()
  })
  it('limits probe cleanup to one masked character and never uses general delete as an input key', () => {
    const input = document.querySelector<HTMLInputElement>('#mbrCtfEncV')!
    input.value = '**'
    const nonempty = lotteKeypad()
    const click = vi.fn()
    document.querySelectorAll('img')[1].addEventListener('click', click)
    expect(eraseLotteKeypadProbe(nonempty.layout!)).toContain('refused')
    input.value = '*'
    const one = lotteKeypad()
    expect(pressLotteKeypad(one.removeId!, 1, one.layout!)).toContain('refused')
    expect(eraseLotteKeypadProbe(one.layout!)).toBe('ok')
    expect(click).toHaveBeenCalledOnce()
  })
})
