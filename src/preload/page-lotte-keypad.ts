import type { LotteKeypadMode, LotteKeypadSnapshot } from '../shared/lotte-keypad'
import {
  readLotteAuth,
  lottePasswordField,
  visibleLotteElement as visible
} from './page-lotte-auth'

// Only public aria-label/alt names observed on Lotte's official keypad are interpreted.
// Never inspect data-action, hidden inputs, image pixels, or the encrypted keypad payload.
const symbols: Readonly<Record<string, string>> = {
  느낌표: '!',
  골뱅이: '@',
  우물표시: '#',
  달러표시: '$',
  퍼센트: '%',
  윗꺽쇠: '^',
  앰퍼샌드: '&',
  별표: '*',
  소괄호열기: '(',
  소괄호닫기: ')',
  빼기표시: '-',
  밑줄: '_',
  같음표: '=',
  더하기표시: '+',
  역슬래시: '\\',
  수직바: '|',
  중괄호열기: '{',
  중괄호닫기: '}',
  대괄호열기: '[',
  대괄호닫기: ']',
  반쌍점: ';',
  쌍점: ':',
  작은따옴표: "'",
  큰따옴표: '"',
  쉼표: ',',
  마침표: '.',
  물결표시: '~',
  강세표: '`',
  빗금: '/',
  물음표: '?',
  공백: ' '
}
const unusedLabels = new Set([
  '확인',
  '닫기',
  '한개지움',
  '모두지움',
  '버튼섞기',
  '거듭인용표열기',
  '거듭인용표닫기'
])

export function readLotteKeypad(
  ensureId: (el: HTMLElement) => number,
  doc: Document = document
): LotteKeypadSnapshot {
  const auth = readLotteAuth(doc)
  if (['signed_in', 'input_error', 'unsupported', 'unknown'].includes(auth.state))
    return {
      state: auth.state as 'signed_in' | 'input_error' | 'unsupported' | 'unknown',
      ...(auth.state === 'unknown' ? { reason: 'auth_unverified' as const } : {})
    }
  const input = lottePasswordField(doc)
  const form = input?.form
  if (!input || !form || form.id !== 'loginForm')
    return { state: 'unknown', reason: 'field_unverified' }
  const toggles = Array.from(
    form.querySelectorAll<HTMLButtonElement>('.idLogin #mbrCtfEncV_keypad')
  ).filter(visible)
  if (toggles.length !== 1 || toggles[0].disabled || toggles[0].type !== 'button')
    return { state: 'unknown', reason: 'opener_unverified' }
  const toggle = toggles[0]
  const filled = input.value.length
  if (filled > 20) return { state: 'unknown', reason: 'invalid_buffer' }
  const roots = Array.from(doc.querySelectorAll<HTMLElement>('#nppfs-keypad-mbrCtfEncV')).filter(
    visible
  )
  if (roots.length > 1 || (roots.length === 1 && !form.contains(roots[0])))
    return { state: 'unknown', reason: 'root_unverified' }
  const root = roots[0]
  if (!root) return { state: 'closed', filled, openId: ensureId(toggle) }
  const groups = Array.from(root.querySelectorAll<HTMLElement>('.kpd-group')).filter(visible)
  if (groups.length !== 1) return { state: 'unknown', reason: 'visible_group_ambiguous' }
  const modes = (['lower', 'upper', 'special'] as const).filter((mode) =>
    groups[0].classList.contains(mode)
  )
  if (modes.length !== 1) return { state: 'unknown', reason: 'mode_ambiguous' }
  const mode = modes[0]
  const keys = new Map<string, number>()
  const controls = new Map<LotteKeypadMode, number>()
  let removeId: number | undefined
  for (const el of Array.from(
    groups[0].querySelectorAll<HTMLElement>('img.kpd-data[role="button"]')
  ).filter(visible)) {
    const label = el.getAttribute('aria-label')?.trim()
    if (!label || label !== el.getAttribute('alt')?.trim())
      return { state: 'unknown', reason: 'label_mismatch' }
    if (label === '한개지움') {
      if (removeId !== undefined) return { state: 'unknown', reason: 'duplicate_delete' }
      removeId = ensureId(el)
      continue
    }
    let character: string | undefined
    if (/^[0-9]$/.test(label)) character = label
    else if (/^소문자 [a-z]$/.test(label)) character = label.slice(-1)
    else if (/^대문자 [A-Z]$/.test(label)) character = label.slice(-1)
    else character = symbols[label]
    if (character !== undefined) {
      if (keys.has(character)) return { state: 'unknown', reason: 'duplicate_character' }
      keys.set(character, ensureId(el))
      continue
    }
    // The official special layout also displays Shift, but its action is unverified.
    // Recognize the public control without exposing an actionable id. Return via 소문자.
    if (mode === 'special' && label === '쉬프트') continue
    const target: LotteKeypadMode | undefined =
      label === '특수문자'
        ? 'special'
        : label === '소문자'
          ? 'lower'
          : label === '쉬프트' && mode !== 'special'
            ? mode === 'lower'
              ? 'upper'
              : 'lower'
            : undefined
    if (target !== undefined) {
      if (controls.has(target)) return { state: 'unknown', reason: 'duplicate_mode_control' }
      controls.set(target, ensureId(el))
    } else if (!unusedLabels.has(label)) return { state: 'unknown', reason: 'unknown_label' }
  }
  if (keys.size === 0) return { state: 'unknown', reason: 'empty_layout' }
  return {
    state: 'open',
    filled,
    mode,
    removeId,
    keys: Array.from(keys, ([character, id]) => ({ character, id })),
    controls: Array.from(controls, ([mode, id]) => ({ mode, id }))
  }
}

export function submitLotteKeypad(expectedLength: number, doc: Document = document): boolean {
  const state = readLotteKeypad(() => 1, doc)
  if (
    !['open', 'closed'].includes(state.state) ||
    state.filled !== expectedLength ||
    !Number.isInteger(expectedLength) ||
    expectedLength < 1 ||
    expectedLength > 20
  )
    return false
  const form = lottePasswordField(doc)?.form
  if (!form) return false
  const buttons = Array.from(
    form.querySelectorAll<HTMLButtonElement>('.idLogin button[type="button"]')
  ).filter(
    (el) =>
      visible(el) &&
      !el.disabled &&
      el.textContent?.trim() === '로그인' &&
      /^fnDoLoginId\(\);\s*return false;?$/.test(el.getAttribute('onclick') ?? '')
  )
  if (buttons.length !== 1) return false
  // Do not press keypad 확인/닫기: they can submit a different path or reset encryption state.
  buttons[0].click()
  return true
}
