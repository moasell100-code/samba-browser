import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import {
  readLotteKeypad,
  submitLotteKeypad,
  focusLotteKeypadPassword
} from '../src/preload/page-lotte-keypad'

const key = (label: string): string =>
  `<img class="kpd-data" role="button" alt="${label}" aria-label="${label}" data-action="never-read">`
const form = `<form id="loginForm"><fieldset class="idLogin"><input id="mbrCtfDrmId"><input id="mbrCtfEncV" name="mbrCtfEncV" type="password" maxlength="20" readonly npkencrypt="on" data-keypad-type="alpha"><button id="mbrCtfEncV_keypad" type="button">보안키패드 열기</button><button type="button" onclick="fnDoLoginId(); return false;">로그인</button></fieldset><div id="nppfs-keypad-mbrCtfEncV"><div class="kpd-group lower">${['소문자 a', '0', '쉬프트', '특수문자', '확인', '닫기', '한개지움'].map(key).join('')}</div><div class="kpd-group upper" hidden>${key('대문자 A')}</div></div></form>`
const windows: JSDOM[] = []
function at(html = form, url = 'https://www.lottecard.co.kr/app/LPMANAA_V200.lc'): Document {
  const dom = new JSDOM(html, { url })
  windows.push(dom)
  return dom.window.document
}
function ids(): (el: HTMLElement) => number {
  const map = new WeakMap<HTMLElement, number>()
  let next = 1
  return (el) => {
    if (!map.has(el)) map.set(el, next++)
    return map.get(el)!
  }
}
afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close()
})
describe('Lotte official public semantic keypad', () => {
  it('focuses the empty readonly password through the official handler without changing security attributes', () => {
    const doc = at()
    const input = doc.querySelector<HTMLInputElement>('#mbrCtfEncV')!
    const root = doc.querySelector<HTMLElement>('#nppfs-keypad-mbrCtfEncV')!
    root.hidden = true
    const focus = vi.fn(() => {
      root.hidden = false
    })
    input.addEventListener('focus', focus)
    expect(focusLotteKeypadPassword(doc)).toBe(true)
    expect(focus).toHaveBeenCalledOnce()
    expect(input.readOnly).toBe(true)
    expect(input.getAttribute('npkencrypt')).toBe('on')
    expect(readLotteKeypad(ids(), doc).state).toBe('open')
  })
  it('does not focus a protected field that already contains input', () => {
    const doc = at()
    const input = doc.querySelector<HTMLInputElement>('#mbrCtfEncV')!
    input.value = '*'
    const focus = vi.fn()
    input.addEventListener('focus', focus)
    expect(focusLotteKeypadPassword(doc)).toBe(false)
    expect(focus).not.toHaveBeenCalled()
    expect(input.value).toBe('*')
  })
  it('retains both identical official special symbol keys and their public labels in DOM order', () => {
    const doc = at()
    const group = doc.querySelector('.kpd-group.lower')!
    group.setAttribute('class', 'kpd-group special')
    const labels = [
      '느낌표',
      '골뱅이',
      '우물표시',
      '달러표시',
      '느낌표',
      '골뱅이',
      '우물표시',
      '달러표시',
      '소문자'
    ]
    group.innerHTML = labels.map(key).join('')
    const state = readLotteKeypad(ids(), doc)
    expect(state.state).toBe('open')
    expect(state.keys?.map((entry) => entry.character)).toEqual([
      '!',
      '@',
      '#',
      '$',
      '!',
      '@',
      '#',
      '$'
    ])
    expect(state.keys?.map((entry) => entry.label)).toEqual(labels.slice(0, -1))
    expect(new Set(state.keys?.map((entry) => entry.id)).size).toBe(8)
  })
  it.each([
    { labels: ['느낌표', '느낌표', '느낌표'] },
    { labels: ['밑줄', '밑줄'] },
    { labels: ['앰퍼센드', '앰퍼샌드'] }
  ])('refuses unsupported special duplicate candidates: $labels', ({ labels }) => {
    const doc = at()
    const group = doc.querySelector('.kpd-group.lower')!
    group.setAttribute('class', 'kpd-group special')
    group.innerHTML = labels.map(key).join('')
    expect(readLotteKeypad(ids(), doc)).toEqual({ state: 'unknown', reason: 'duplicate_character' })
  })
  it('recognizes but never exposes the unverified Shift control in the official special layout', () => {
    const doc = at()
    const group = doc.querySelector('.kpd-group.lower')!
    group.setAttribute('class', 'kpd-group special')
    group.innerHTML = ['느낌표', '앰퍼센드', '쉬프트', '소문자', '한개지움', '확인']
      .map(key)
      .join('')
    const ensureId = vi.fn(ids())
    const state = readLotteKeypad(ensureId, doc)
    expect(state.state).toBe('open')
    expect(state.keys?.map((entry) => entry.character)).toEqual(['!', '&'])
    expect(state.controls?.map((entry) => entry.mode)).toEqual(['lower'])
    expect(ensureId.mock.calls.map(([el]) => el.getAttribute('aria-label'))).not.toContain('쉬프트')
  })
  it('reads public accessible labels without inspecting encrypted action attributes', () => {
    const doc = at()
    for (const node of doc.querySelectorAll('img')) {
      const original = node.getAttribute.bind(node)
      vi.spyOn(node, 'getAttribute').mockImplementation((name) => {
        if (name === 'data-action') throw new Error('encrypted payload must not be read')
        return original(name)
      })
    }
    const state = readLotteKeypad(ids(), doc)
    expect(state).toMatchObject({ state: 'open', filled: 0, mode: 'lower' })
    expect(state.keys?.map((entry) => entry.character)).toEqual(['a', '0'])
    expect(state.controls?.map((entry) => entry.mode)).toEqual(['upper', 'special'])
    expect(state.removeId).toBeTypeOf('number')
    expect(JSON.stringify(state)).not.toMatch(/never-read|확인|닫기/)
  })
  it('ignores hidden duplicate fields and their values', () => {
    const doc = at(`<div hidden>${form}</div>${form}`)
    const hidden = doc.querySelector<HTMLInputElement>('#mbrCtfEncV')!
    const value = vi.spyOn(hidden, 'value', 'get').mockImplementation(() => {
      throw new Error('hidden value')
    })
    expect(readLotteKeypad(ids(), doc).state).toBe('open')
    expect(value).not.toHaveBeenCalled()
  })
  it.each(['position:absolute;left:-9999px', 'clip:rect(0px, 0px, 0px, 0px)', 'display:none'])(
    'rejects nonvisible keypad groups (%s)',
    (style) => {
      const doc = at()
      doc.querySelector('.kpd-group.lower')!.setAttribute('style', style)
      expect(readLotteKeypad(ids(), doc).state).toBe('unknown')
    }
  )
  it('refuses duplicate public character labels, conflicting labels, or multiple visible modes', () => {
    const duplicate = at()
    duplicate.querySelector('.lower')!.insertAdjacentHTML('beforeend', key('소문자 a'))
    expect(readLotteKeypad(ids(), duplicate).state).toBe('unknown')
    const mismatch = at()
    mismatch.querySelector('img')!.setAttribute('alt', '소문자 b')
    expect(readLotteKeypad(ids(), mismatch).state).toBe('unknown')
    const modes = at()
    modes.querySelector('.upper')!.removeAttribute('hidden')
    expect(readLotteKeypad(ids(), modes).state).toBe('unknown')
  })
  it('requires exact origin and keypad containment in the validated form', () => {
    expect(
      readLotteKeypad(ids(), at(form, 'https://www.lottecard.co.kr:8443/app/LPMANAA_V200.lc')).state
    ).toBe('unsupported')
    const doc = at()
    doc.body.append(doc.querySelector('#nppfs-keypad-mbrCtfEncV')!)
    expect(readLotteKeypad(ids(), doc).state).toBe('unknown')
  })
  it('submits the same official form once without closing or confirming the keypad', () => {
    const doc = at()
    const input = doc.querySelector<HTMLInputElement>('#mbrCtfEncV')!
    input.value = '*******'
    const login = vi.fn()
    const keypad = vi.fn()
    doc.querySelector('button[onclick]')!.addEventListener('click', login)
    doc.querySelector('#nppfs-keypad-mbrCtfEncV')!.addEventListener('click', keypad)
    expect(submitLotteKeypad(6, doc)).toBe(false)
    expect(submitLotteKeypad(7, doc)).toBe(true)
    expect(login).toHaveBeenCalledOnce()
    expect(keypad).not.toHaveBeenCalled()
    expect(input.readOnly).toBe(true)
  })
  it('does not submit a different form with a duplicate loginForm id', () => {
    const doc = at(
      form.replace('onclick="fnDoLoginId(); return false;"', '') +
        '<form id="loginForm"><fieldset class="idLogin"><button type="button" onclick="fnDoLoginId(); return false;">로그인</button></fieldset></form>'
    )
    doc.querySelector<HTMLInputElement>('#mbrCtfEncV')!.value = '*'
    const click = vi.fn()
    doc.querySelector('button[onclick]')!.addEventListener('click', click)
    expect(submitLotteKeypad(1, doc)).toBe(false)
    expect(click).not.toHaveBeenCalled()
  })
})
