import { isLotteOrigin, type LotteLoginBridge } from './lotte-login'
import type { LotteAuthSnapshot } from '../../shared/lotte-auth'

export type LotteKeyboardProbeResult =
  | 'accepted_and_cleared'
  | 'unsupported'
  | 'signed_in'
  | 'not_ready'
  | 'keypad_required'
  | 'field_not_empty'
  | 'focus_unavailable'
  | 'mode_changed'
  | 'input_not_accepted'
  | 'input_count_changed'
  | 'input_focus_lost'
  | 'input_rejected'
  | 'cleanup_needed'
  | 'navigation_changed'
  | 'cancelled'
  | 'error'

interface ProbeDeps {
  bridge: Pick<LotteLoginBridge, 'url' | 'read' | 'focusPassword' | 'pressCharacter'> & {
    eraseCharacter: () => Promise<boolean>
  }
  tick: () => string | null
  sleep?: (ms: number) => Promise<void>
}

// Noncredential input capability probe. No vault, submit, or attempt-store dependency exists.
export async function probeLotteKeyboard(deps: ProbeDeps): Promise<LotteKeyboardProbeResult> {
  const { bridge } = deps
  const startUrl = bridge.url()
  if (!isLotteOrigin(startUrl)) return 'unsupported'
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const gate = (): LotteKeyboardProbeResult | null =>
    deps.tick() ? 'cancelled' : bridge.url() !== startUrl ? 'navigation_changed' : null
  const read = async (): Promise<LotteAuthSnapshot> => bridge.read()
  try {
    let blocked = gate()
    if (blocked) return blocked
    let state = await read()
    blocked = gate()
    if (blocked) return blocked
    if (state.state === 'signed_in') return 'signed_in'
    if (state.state === 'keypad_required') return 'keypad_required'
    if (state.state !== 'keyboard_ready') return 'not_ready'
    if (state.filled !== 0) return 'field_not_empty'
    state = await bridge.focusPassword()
    blocked = gate()
    if (blocked) return blocked
    if (state.state === 'keypad_required') return 'keypad_required'
    if (state.state !== 'keyboard_ready') return 'not_ready'
    if (!state.focused) return 'focus_unavailable'
    if (state.filled !== 0) return 'field_not_empty'
    if (!(await bridge.pressCharacter('a', 0))) return 'input_rejected'
    let accepted = false
    for (let poll = 0; poll < 20; poll++) {
      await sleep(100)
      blocked = gate()
      if (blocked) return blocked
      state = await read()
      blocked = gate()
      if (blocked) return blocked
      if (state.state !== 'keyboard_ready') return 'mode_changed'
      if (state.filled !== 0 && state.filled !== 1) return 'input_count_changed'
      if (state.focused && state.filled === 1) {
        accepted = true
        break
      }
    }
    if (!accepted) return state.focused ? 'input_not_accepted' : 'input_focus_lost'
    blocked = gate()
    if (blocked) return blocked
    if (!(await bridge.eraseCharacter())) return 'cleanup_needed'
    for (let poll = 0; poll < 20; poll++) {
      await sleep(100)
      blocked = gate()
      if (blocked) return blocked
      state = await read()
      blocked = gate()
      if (blocked) return blocked
      if (state.state !== 'keyboard_ready') return 'cleanup_needed'
      if (state.filled === 0) return 'accepted_and_cleared'
      if (state.filled !== 1 || !state.focused) return 'cleanup_needed'
    }
    return 'cleanup_needed'
  } catch {
    return 'error'
  }
}
