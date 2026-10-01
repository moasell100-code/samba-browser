import { app } from 'electron'
import { join } from 'node:path'
import type { LotteKeypadMode, LotteKeypadSnapshot } from '../../shared/lotte-keypad'
import { HyundaiAttemptStore, type HyundaiAttempt, type HyundaiAttempts } from './hyundai-attempts'
import { isLotteOrigin, LOTTE_LOGIN_URL } from './lotte-login'

let defaultAttempts: HyundaiAttempts | undefined
export function lotteKeypadAttempts(): HyundaiAttempts {
  const userData = app.getPath('userData')
  if (!userData) throw new Error('Lotte keypad attempt storage unavailable')
  // A separate corrective path: never reset the previous native-input failure latch.
  return (defaultAttempts ??= new HyundaiAttemptStore(
    join(userData, 'lotte-keypad-login-attempts')
  ))
}

export interface LotteKeypadBridge {
  url: () => string
  read: () => Promise<LotteKeypadSnapshot>
  fillUsername: () => Promise<string>
  press: (id: number, expectedLength: number, layout: number) => Promise<boolean>
  submit: (expectedLength: number) => Promise<boolean>
  navigate: (url: string) => Promise<void>
  waitForLoad: () => Promise<void>
}
interface LotteKeypadLoginDeps {
  bridge: LotteKeypadBridge
  attempts: HyundaiAttempts
  attempt: HyundaiAttempt
  readSavedPassword: () => string | null
  autoSubmit: boolean
  tick: () => string | null
  verifyTarget: () => string | null
  sleep?: (ms: number) => Promise<void>
}
const UNVERIFIED = 'refused: Lotte Card official keypad could not be verified; no submit or retry'
const INPUT_FAILED =
  'refused: Lotte Card official keypad input was not accepted; no submit or retry'
const MODES: LotteKeypadMode[] = ['lower', 'upper', 'special']

function verifiedCandidates(
  keys: NonNullable<LotteKeypadSnapshot['keys']>,
  mode: LotteKeypadMode | undefined
): boolean {
  return (
    keys.length === 1 ||
    (keys.length === 2 &&
      mode === 'special' &&
      ['!', '@', '#', '$'].includes(keys[0].character) &&
      keys[0].character === keys[1].character &&
      !!keys[0].label &&
      keys[0].label === keys[1].label &&
      keys[0].id !== keys[1].id)
  )
}

export async function loginLotteKeypad(deps: LotteKeypadLoginDeps): Promise<string> {
  const { bridge, attempts, attempt } = deps
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let begun = false
  let succeeded = false
  let stage:
    | 'initial_state'
    | 'navigate_login'
    | 'fill_username'
    | 'after_username'
    | 'open_keypad'
    | 'preflight_lower'
    | 'preflight_upper'
    | 'preflight_special'
    | 'restore_lower'
    | 'read_secret'
    | 'password_input'
    | 'submit'
    | 'verify_session' = 'initial_state'
  let reason = 'operation_failed'
  const refused = (): string => `${UNVERIFIED} [stage=${stage}; reason=${reason}]`
  const gate = (): string | null =>
    deps.tick() ?? (!isLotteOrigin(bridge.url()) ? UNVERIFIED : deps.verifyTarget())
  const read = async (): Promise<LotteKeypadSnapshot> => {
    const url = bridge.url()
    if (gate()) throw new Error('stopped')
    const snapshot = await bridge.read()
    reason =
      snapshot.reason ?? (snapshot.state === 'unknown' ? 'unknown_state' : 'operation_failed')
    if (bridge.url() !== url || gate()) throw new Error('stopped')
    return snapshot
  }
  const success = (): string => {
    attempts.succeeded(attempt)
    succeeded = true
    return 'signed in: Lotte Card session verified; continue the requested collection'
  }
  const press = async (
    id: number | undefined,
    state: LotteKeypadSnapshot,
    count: number
  ): Promise<void> => {
    if (
      gate() ||
      !Number.isInteger(id) ||
      !Number.isInteger(state.layout) ||
      state.filled !== count
    )
      throw new Error('stopped')
    if (!(await bridge.press(id!, count, state.layout!))) {
      reason = 'press_rejected'
      throw new Error('stopped')
    }
  }
  const mode = async (target: LotteKeypadMode, count: number): Promise<LotteKeypadSnapshot> => {
    let state = await read()
    for (let transitions = 0; transitions < 3; transitions++) {
      if (state.state !== 'open' || state.filled !== count) throw new Error('stopped')
      if (state.mode === target) return state
      const next =
        state.controls?.find((control) => control.mode === target) ??
        state.controls?.find((control) => control.mode === 'lower')
      if (!next) {
        reason = 'mode_control_unavailable'
        throw new Error('stopped')
      }
      await press(next.id, state, count)
      let changed = false
      for (let poll = 0; poll < 20; poll++) {
        await sleep(100)
        state = await read()
        if (state.state !== 'open' || state.filled !== count) throw new Error('stopped')
        if (state.mode === next.mode) {
          changed = true
          break
        }
      }
      if (!changed) {
        reason = 'mode_transition_unconfirmed'
        throw new Error('stopped')
      }
    }
    throw new Error('stopped')
  }
  try {
    const blocked = gate()
    if (blocked) return blocked
    let state = await read()
    if (state.state === 'signed_in') return success()
    if (state.state === 'unknown') {
      stage = 'navigate_login'
      await bridge.navigate(LOTTE_LOGIN_URL)
      await bridge.waitForLoad()
      state = await read()
    }
    if (state.state === 'signed_in') return success()
    if (!['open', 'closed'].includes(state.state)) return refused()
    if (state.filled !== 0)
      return 'refused: Lotte Card password field is not empty; no input or submit'
    if (!deps.autoSubmit)
      return 'refused: automatic login submission is disabled; no password entered'
    stage = 'fill_username'
    if ((await bridge.fillUsername()) !== 'ok') {
      reason = 'username_fill_rejected'
      return refused()
    }
    stage = 'after_username'
    state = await read()
    if (state.state === 'closed') {
      stage = 'open_keypad'
      await press(state.openId, state, 0)
      for (let poll = 0; poll < 20; poll++) {
        await sleep(100)
        state = await read()
        if (state.state !== 'closed') break
      }
    }
    if (state.state !== 'open' || state.filled !== 0) return refused()
    // Inspect every public layout in a fixed order before touching KeyMaster. This neither
    // types a secret nor tells the page which modes/characters the saved password needs.
    const available = new Map<string, LotteKeypadMode[]>()
    for (const target of MODES) {
      stage =
        target === 'lower'
          ? 'preflight_lower'
          : target === 'upper'
            ? 'preflight_upper'
            : 'preflight_special'
      state = await mode(target, 0)
      if (!state.keys?.length) return refused()
      for (const key of state.keys) {
        if (!/^[\x20-\x7e]$/.test(key.character)) return refused()
        if (
          !verifiedCandidates(
            state.keys.filter((candidate) => candidate.character === key.character),
            state.mode
          )
        )
          return refused()
        available.set(key.character, [...(available.get(key.character) ?? []), target])
      }
    }
    stage = 'restore_lower'
    state = await mode('lower', 0)
    if (gate()) return refused()
    stage = 'read_secret'
    const password = deps.readSavedPassword()
    if (password === null) return 'not found: no Lotte Card login password saved in KeyMaster'
    if (
      password.length < 1 ||
      password.length > 20 ||
      !/^[\x20-\x7e]+$/.test(password) ||
      [...password].some((character) => !available.has(character))
    )
      return 'refused: saved Lotte Card password is not supported by the verified public keypad labels; no input or submit'
    for (let index = 0; index < password.length; index++) {
      stage = 'password_input'
      state = await read()
      if (state.state !== 'open' || state.filled !== index) return refused()
      if (!state.keys?.some((key) => key.character === password[index]))
        state = await mode(available.get(password[index])![0], index)
      const matches = state.keys?.filter((key) => key.character === password[index]) ?? []
      if (!verifiedCandidates(matches, state.mode)) return refused()
      if (!begun) {
        if (!attempts.begin(attempt))
          return 'refused: Lotte Card keypad login was already attempted; do not retry'
        begun = true
      }
      // Both visible duplicate keys mean the same symbol. Always select the first in DOM
      // order, while the fresh revision still covers every candidate's public label and id.
      await press(matches[0].id, state, index)
      let accepted = false
      for (let poll = 0; poll < 20; poll++) {
        await sleep(100)
        state = await read()
        if (!['open', 'closed'].includes(state.state)) return INPUT_FAILED
        if (state.filled === index + 1) {
          accepted = true
          break
        }
        if (state.filled !== index) return INPUT_FAILED
      }
      if (!accepted) return INPUT_FAILED
    }
    stage = 'submit'
    if (gate() || !(await bridge.submit(password.length))) return refused()
    stage = 'verify_session'
    await bridge.waitForLoad()
    for (let poll = 0; poll < 16; poll++) {
      state = await read()
      if (state.state === 'signed_in') return success()
      if (['input_error', 'unsupported'].includes(state.state)) return refused()
      await sleep(500)
    }
    return 'needs_user: Lotte Card login was submitted once but is not confirmed; do not retry'
  } catch {
    return refused()
  } finally {
    if (begun && !succeeded) {
      try {
        attempts.failed(attempt)
      } catch {
        /* the pending record also prevents retries */
      }
    }
  }
}
