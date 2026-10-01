import type { HyundaiAuthSnapshot } from '../../shared/hyundai-auth'
import { isHyundaiCardHost, isValidHyundaiPin } from '../../shared/login-method'
import { FRAME_ID_STRIDE } from '../browser/frame-id'
import type { HyundaiAttempt, HyundaiAttempts } from './hyundai-attempts'

export const HYUNDAI_LOGIN_URL = 'https://www.hyundaicard.com/index.jsp'
export const HYUNDAI_PIN_USE_LOGIN =
  'refused: Hyundai Card PIN must use login; never fill or press its digits directly'
export const HYUNDAI_PIN_ALREADY_TRIED =
  'refused: Hyundai Card PIN was already attempted. Do not retry. Complete login yourself or update the saved PIN in KeyMaster.'

/** No subdomains, URL credentials or nondefault ports are allowed to receive the PIN. */
export function isHyundaiLoginUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      !url.port &&
      !url.username &&
      !url.password &&
      isHyundaiCardHost(url.hostname)
    )
  } catch {
    return false
  }
}

export interface HyundaiLoginBridge {
  url: () => string
  read: () => Promise<HyundaiAuthSnapshot>
  navigate: (url: string) => Promise<void>
  pressOnce: (id: number) => Promise<string>
  waitForLoad: () => Promise<void>
}

interface HyundaiLoginDeps {
  bridge: HyundaiLoginBridge
  attempts: HyundaiAttempts
  attempt: HyundaiAttempt
  /** Only the main-process vault can supply the saved login/value; there is no model argument. */
  readSavedPin: () => string | null
  autoSubmit: boolean
  tick: () => string | null
  verifyTarget: () => string | null
  sleep?: (ms: number) => Promise<void>
}

const mainId = (id: number | undefined): id is number =>
  id !== undefined && Number.isInteger(id) && id > 0 && id < FRAME_ID_STRIDE

function keypad(snapshot: HyundaiAuthSnapshot): Map<string, number> | null {
  if (snapshot.state !== 'pin_ready' || !mainId(snapshot.inputId) || snapshot.digits?.length !== 10)
    return null
  const digits = new Map<string, number>()
  const ids = new Set<number>()
  for (const key of snapshot.digits) {
    if (
      !/^[0-9]$/.test(key.digit) ||
      !mainId(key.id) ||
      key.id === snapshot.inputId ||
      digits.has(key.digit) ||
      ids.has(key.id)
    )
      return null
    digits.set(key.digit, key.id)
    ids.add(key.id)
  }
  return digits
}

function stateNotice(state: HyundaiAuthSnapshot['state']): string {
  switch (state) {
    case 'registration_required':
      return 'needs_user: register Hyundai Card simple PIN on this device before automatic login'
    case 'additional_auth':
      return 'needs_user: complete Hyundai Card additional authentication on screen; no PIN retry'
    case 'pin_error':
      return 'refused: Hyundai Card PIN login failed; check the saved PIN in KeyMaster. Do not retry'
    case 'unsupported':
      return 'needs_user: Hyundai Card simple PIN is unavailable on this device'
    default:
      return 'refused: Hyundai Card login state could not be verified; no further PIN input'
  }
}

/** One complete attempt, with fresh DOM and filled-count validation before every digit. */
export async function loginHyundaiCard(deps: HyundaiLoginDeps): Promise<string> {
  const { bridge, attempts, attempt } = deps
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let begun = false
  let succeeded = false
  const gate = (): string | null =>
    deps.tick() ??
    (!isHyundaiLoginUrl(bridge.url())
      ? 'refused: Hyundai Card login origin changed'
      : deps.verifyTarget())
  const read = async (): Promise<HyundaiAuthSnapshot> => {
    const before = bridge.url()
    if (!isHyundaiLoginUrl(before)) return { state: 'unsupported' }
    const snapshot = await bridge.read()
    if (bridge.url() !== before || !isHyundaiLoginUrl(bridge.url())) return { state: 'unknown' }
    return snapshot
  }
  const signedIn = (): string => {
    attempts.succeeded(attempt)
    succeeded = true
    return 'signed in: Hyundai Card session verified; continue the requested collection'
  }
  try {
    let blocked = gate()
    if (blocked) return blocked
    let snapshot = await read()
    if (snapshot.state === 'signed_in') return signedIn()
    // Sixth-digit entry submits immediately on Hyundai; do not partially type with submission disabled.
    if (!deps.autoSubmit)
      return 'refused: automatic submit is disabled; Hyundai Card PIN automatically submits on its sixth digit'
    const pin = deps.readSavedPin()
    if (pin === null) return 'not found: save Hyundai Card simple PIN in the KeyMaster login item'
    if (!isValidHyundaiPin(pin))
      return 'refused: saved Hyundai Card PIN must contain exactly six digits; update it in KeyMaster'
    // Unknown expired-session pages can only go to the public entry once. Known blocking states stop.
    if (snapshot.state === 'unknown') {
      blocked = gate()
      if (blocked) return blocked
      await bridge.navigate(HYUNDAI_LOGIN_URL)
      await bridge.waitForLoad()
      blocked = gate()
      if (blocked) return blocked
      snapshot = await read()
    }
    if (snapshot.state === 'signed_in') return signedIn()
    if (snapshot.state !== 'pin_ready') return stateNotice(snapshot.state)
    if (snapshot.filled !== 0 || !mainId(snapshot.inputId)) {
      return 'refused: Hyundai Card PIN input is not empty or cannot be verified; clear it yourself before login'
    }
    if (!snapshot.digits) {
      blocked = gate()
      if (blocked) return blocked
      const opened = await bridge.pressOnce(snapshot.inputId)
      if (opened !== 'ok') return 'refused: Hyundai Card PIN keypad did not open'
      await sleep(200)
    }
    for (let index = 0; index < pin.length; index++) {
      blocked = gate()
      if (blocked) return blocked
      snapshot = await read()
      if (snapshot.state === 'signed_in') return signedIn()
      if (snapshot.state !== 'pin_ready') return stateNotice(snapshot.state)
      const layout = keypad(snapshot)
      if (!layout || snapshot.filled !== index) {
        return 'refused: Hyundai Card PIN keypad or input count changed; no repeated key presses'
      }
      // Recheck after the asynchronous reader and before every mutation, including the auto-submit digit.
      blocked = gate()
      if (blocked) return blocked
      if (!begun) {
        if (!attempts.begin(attempt)) return HYUNDAI_PIN_ALREADY_TRIED
        begun = true
      }
      if ((await bridge.pressOnce(layout.get(pin[index])!)) !== 'ok') {
        return 'refused: Hyundai Card PIN key press could not be verified; do not retry'
      }
      await sleep(200)
    }
    // No submitForm: the real keypad submits itself at six digits. Only observe the outcome.
    for (let poll = 0; poll < 16; poll++) {
      blocked = gate()
      if (blocked) return blocked
      snapshot = await read()
      if (snapshot.state === 'signed_in') return signedIn()
      if (
        ['pin_error', 'registration_required', 'additional_auth', 'unsupported'].includes(
          snapshot.state
        )
      ) {
        return stateNotice(snapshot.state)
      }
      await sleep(500)
    }
    return 'needs_user: Hyundai Card PIN was submitted once but login is not confirmed; check the screen and do not retry'
  } catch {
    // Page errors can contain page content; never propagate them through the model-facing tool.
    return 'refused: Hyundai Card PIN login could not be verified; no retry was made'
  } finally {
    if (begun && !succeeded) {
      try {
        attempts.failed(attempt)
      } catch {
        /* pending is also a blocking latch */
      }
    }
  }
}
