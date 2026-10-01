import { app } from 'electron'
import { join } from 'node:path'
import type { LotteAuthSnapshot } from '../../shared/lotte-auth'
import { HyundaiAttemptStore, type HyundaiAttempt, type HyundaiAttempts } from './hyundai-attempts'

export const LOTTE_LOGIN_URL = 'https://www.lottecard.co.kr/app/LPMANAA_V200.lc'
export const LOTTE_USE_LOGIN =
  'refused: Lotte Card login must use the dedicated login tool; do not fill its protected password field directly'
export const LOTTE_KEYPAD_REQUIRED =
  'needs_user: Lotte Card requires its official secure keypad (keypad_required). The supported keyboard security program is unavailable or keypad mode is active. No further password input was attempted; do not retry with DOM fill.'

export function isLotteOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.hostname === 'www.lottecard.co.kr' &&
      !url.port &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

let defaultAttempts: HyundaiAttempts | undefined
export function lotteAttempts(): HyundaiAttempts {
  const userData = app.getPath('userData')
  if (!userData) throw new Error('Lotte attempt storage unavailable')
  return (defaultAttempts ??= new HyundaiAttemptStore(join(userData, 'lotte-login-attempts')))
}

export interface LotteLoginBridge {
  url: () => string
  read: () => Promise<LotteAuthSnapshot>
  focusPassword: () => Promise<LotteAuthSnapshot>
  fillUsername: () => Promise<string>
  pressCharacter: (character: string, expectedLength: number) => Promise<boolean>
  submit: (expectedLength: number) => Promise<boolean>
  navigate: (url: string) => Promise<void>
  waitForLoad: () => Promise<void>
}

interface LotteLoginDeps {
  bridge: LotteLoginBridge
  attempts: HyundaiAttempts
  attempt: HyundaiAttempt
  readSavedPassword: () => string | null
  autoSubmit: boolean
  tick: () => string | null
  verifyTarget: () => string | null
  sleep?: (ms: number) => Promise<void>
}

function notice(state: LotteAuthSnapshot['state']): string {
  if (state === 'keypad_required') return LOTTE_KEYPAD_REQUIRED
  if (state === 'input_error')
    return 'refused: Lotte Card secure input error; no further login attempt. Check the official keyboard security program.'
  if (state === 'initializing')
    return 'refused: Lotte Card keyboard security is still initializing; no further password input'
  return 'refused: Lotte Card login input could not be verified; no further input'
}

function inputNotice(state: LotteAuthSnapshot, expectedLength: number): string {
  if (state.state !== 'keyboard_ready')
    return `refused: lotte_input_mode_changed (${state.state}); no submit or retry`
  if (!state.focused) return 'refused: lotte_input_focus_lost; no submit or retry'
  if (state.filled === expectedLength)
    return 'refused: lotte_input_not_accepted; the official keyboard security client did not accept the keyboard event; no submit or retry'
  return 'refused: lotte_input_count_mismatch; no submit or retry'
}

export async function loginLotteCard(deps: LotteLoginDeps): Promise<string> {
  const { bridge, attempts, attempt } = deps
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let begun = false
  let succeeded = false
  const gate = (): string | null =>
    deps.tick() ??
    (!isLotteOrigin(bridge.url()) ? 'refused: Lotte Card origin changed' : deps.verifyTarget())
  const read = async (): Promise<LotteAuthSnapshot> => {
    const url = bridge.url()
    if (!isLotteOrigin(url)) return { state: 'unsupported' }
    const result = await bridge.read()
    return bridge.url() === url ? result : { state: 'unknown' }
  }
  const success = (): string => {
    attempts.succeeded(attempt)
    succeeded = true
    return 'signed in: Lotte Card session verified; continue the requested collection'
  }
  try {
    let blocked = gate()
    if (blocked) return blocked
    let state = await read()
    if (state.state === 'signed_in') return success()
    if (state.state === 'unknown') {
      await bridge.navigate(LOTTE_LOGIN_URL)
      await bridge.waitForLoad()
      blocked = gate()
      if (blocked) return blocked
      state = await read()
    }
    for (let wait = 0; state.state === 'initializing' && wait < 20; wait++) {
      await sleep(250)
      blocked = gate()
      if (blocked) return blocked
      state = await read()
    }
    if (state.state === 'signed_in') return success()
    if (state.state !== 'keyboard_ready') return notice(state.state)
    if (state.filled !== 0)
      return 'refused: Lotte Card password field is not empty; no input or submit'
    if (!deps.autoSubmit)
      return 'refused: automatic login submission is disabled; no password entered'
    blocked = gate()
    if (blocked) return blocked
    if ((await bridge.fillUsername()) !== 'ok')
      return 'refused: Lotte Card username could not be filled'
    state = await bridge.focusPassword()
    // Focus can switch to mandatory keypad. Check before requesting any secret from KeyMaster.
    if (state.state !== 'keyboard_ready') return notice(state.state)
    if (!state.focused || state.filled !== 0)
      return 'refused: Lotte Card password focus or empty state could not be verified'
    blocked = gate()
    if (blocked) return blocked
    const password = deps.readSavedPassword()
    if (password === null) return 'not found: no Lotte Card login password saved in KeyMaster'
    if (password.length < 1 || password.length > 20 || !/^[\x20-\x7e]+$/.test(password))
      return 'refused: saved Lotte Card password cannot use the supported keyboard input path'
    for (let index = 0; index < password.length; index++) {
      blocked = gate()
      if (blocked) return blocked
      state = await read()
      if (state.state !== 'keyboard_ready') return notice(state.state)
      if (!state.focused || state.filled !== index) return inputNotice(state, index)
      if (!begun) {
        if (!attempts.begin(attempt))
          return 'refused: Lotte Card login was already attempted; do not retry'
        begun = true
      }
      if (!(await bridge.pressCharacter(password[index], index)))
        return 'refused: lotte_native_input_rejected; no submit or retry'
      // The supported security client may update its input asynchronously. Observe only;
      // never resend the character, edit readonly, or manufacture encryption state.
      let accepted = false
      for (let poll = 0; poll < 20; poll++) {
        await sleep(100)
        blocked = gate()
        if (blocked) return blocked
        state = await read()
        if (state.state === 'signed_in') return success()
        if (state.state !== 'keyboard_ready') return inputNotice(state, index)
        if (state.focused && state.filled === index + 1) {
          accepted = true
          break
        }
        if (state.filled !== index && state.filled !== index + 1) return inputNotice(state, index)
      }
      if (!accepted) return inputNotice(state, index)
    }
    blocked = gate()
    if (blocked) return blocked
    if (!(await bridge.submit(password.length)))
      return 'refused: Lotte Card protected login submit could not be verified; do not retry'
    await bridge.waitForLoad()
    for (let poll = 0; poll < 16; poll++) {
      blocked = gate()
      if (blocked) return blocked
      state = await read()
      if (state.state === 'signed_in') return success()
      if (state.state === 'input_error' || state.state === 'unsupported') return notice(state.state)
      await sleep(500)
    }
    return 'needs_user: Lotte Card login was submitted once but is not confirmed; do not retry'
  } catch {
    return 'refused: Lotte Card login could not be verified; no retry was made'
  } finally {
    if (begun && !succeeded) {
      try {
        attempts.failed(attempt)
      } catch {
        /* an existing pending record also prevents retries */
      }
    }
  }
}
