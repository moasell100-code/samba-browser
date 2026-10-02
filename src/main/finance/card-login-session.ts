import type { Tab, TabManager } from '../browser/tab-manager'
import type { VaultService } from '../vault/service'
import type { Settings } from '../../shared/settings'
import type { LotteKeypadReason, LotteKeypadSnapshot } from '../../shared/lotte-keypad'
import { createSambaTools } from '../agent/tools'
import { pageBridge } from '../browser/page-bridge'
import {
  issuerForCardUrl,
  inspectCardPage,
  type CardPageDiagnostics
} from './card-page-diagnostics'
import { observeSamsungLoginAlerts } from './samsung-login-outcome'
import { lotteAttempts } from './lotte-login'
import { lotteKeypadAttempts } from './lotte-keypad-login'

const KEYPAD_STATES: readonly LotteKeypadSnapshot['state'][] = [
  'open',
  'closed',
  'signed_in',
  'input_error',
  'unknown',
  'unsupported'
]
const KEYPAD_REASONS: readonly LotteKeypadReason[] = [
  'auth_unverified',
  'field_unverified',
  'opener_unverified',
  'invalid_buffer',
  'root_unverified',
  'visible_group_ambiguous',
  'mode_ambiguous',
  'label_mismatch',
  'duplicate_delete',
  'duplicate_character',
  'duplicate_mode_control',
  'unknown_label',
  'empty_layout'
]
const LOGIN_STAGES = [
  'initial_state',
  'navigate_login',
  'fill_username',
  'after_username',
  'focus_keypad',
  'open_keypad',
  'preflight_lower',
  'preflight_upper',
  'preflight_special',
  'restore_lower',
  'read_secret',
  'password_input',
  'submit',
  'verify_session'
] as const
const LOGIN_REASONS = [
  ...KEYPAD_REASONS,
  'operation_failed',
  'unknown_state',
  'press_rejected',
  'mode_control_unavailable',
  'mode_transition_unconfirmed',
  'username_fill_rejected',
  'focus_rejected',
  'keypad_remained_closed'
] as const
type LoginStage = (typeof LOGIN_STAGES)[number]
type LoginReason = (typeof LOGIN_REASONS)[number]

export interface CardSessionRestoreResult {
  state: string
  auth: string
  stage?: LoginStage
  reason?: LoginReason
}

/** Fixed status projection only: never expose the filled length, mode, keys or layout. */
export async function inspectLotteKeypadStatus(
  tab: Tab
): Promise<{ state: LotteKeypadSnapshot['state']; reason?: LotteKeypadReason }> {
  try {
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return { state: 'unknown' }
    const initialUrl = wc.getURL()
    if (issuerForCardUrl(initialUrl) !== 'lotte_card') return { state: 'unsupported' }
    const snapshot = await pageBridge.lotteKeypad(tab)
    if (wc.isDestroyed() || wc.getURL() !== initialUrl) return { state: 'unknown' }
    if (!KEYPAD_STATES.includes(snapshot.state)) return { state: 'unknown' }
    return {
      state: snapshot.state,
      ...(snapshot.reason && KEYPAD_REASONS.includes(snapshot.reason)
        ? { reason: snapshot.reason }
        : {})
    }
  } catch {
    return { state: 'unknown' }
  }
}

function classifyLoginResult(raw: string): Omit<CardSessionRestoreResult, 'auth'> {
  const keypadPrefix =
    'refused: Lotte Card official keypad could not be verified; no submit or retry'
  const diagnostics = new RegExp(
    `${keypadPrefix} \\[stage=([a-z_]{1,40}); reason=([a-z_]{1,40})\\]`
  ).exec(raw)
  const safeDiagnostics: Pick<CardSessionRestoreResult, 'stage' | 'reason'> = {}
  if (diagnostics) {
    if ((LOGIN_STAGES as readonly string[]).includes(diagnostics[1]))
      safeDiagnostics.stage = diagnostics[1] as LoginStage
    if ((LOGIN_REASONS as readonly string[]).includes(diagnostics[2]))
      safeDiagnostics.reason = diagnostics[2] as LoginReason
  }
  // "No submit or retry" describes many safe early stops, not an attempt-store rejection.
  if (
    /refused: (?:Lotte Card(?: keypad)? login|Hyundai Card PIN) was already attempted(?:;|\.)/.test(
      raw
    )
  )
    return { state: 'attempt_protected' }
  if (raw.includes(keypadPrefix)) return { state: 'keypad_unverified', ...safeDiagnostics }
  if (
    raw.includes('refused: Lotte Card official keypad input was not accepted; no submit or retry')
  )
    return { state: 'input_not_accepted', stage: 'password_input' }
  if (/locked/i.test(raw)) return { state: 'vault_locked' }
  if (/^needs_user:/i.test(raw)) return { state: 'user_verification_required' }
  if (/fields not found/i.test(raw)) return { state: 'login_fields_unavailable' }
  if (/not found/i.test(raw)) return { state: 'saved_account_unavailable' }
  if (/refused|denied|disabled/i.test(raw)) return { state: 'policy_blocked' }
  return { state: 'login_unconfirmed' }
}

function waitForSamsungStatus(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, delay)
    if (signal.aborted) finish()
    else signal.addEventListener('abort', finish, { once: true })
  })
}

function inspectBeforeDeadline(
  tab: Tab,
  deadline: number,
  signal: AbortSignal,
  shouldStop: () => boolean
): Promise<CardPageDiagnostics | null> {
  return new Promise((resolve) => {
    let finished = false
    const finish = (value: CardPageDiagnostics | null): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      clearInterval(guard)
      signal.removeEventListener('abort', stop)
      resolve(value)
    }
    const stop = (): void => finish(null)
    const timer = setTimeout(stop, Math.max(0, deadline - Date.now()))
    const guard = setInterval(() => {
      if (shouldStop()) stop()
    }, 750)
    if (signal.aborted || Date.now() >= deadline || shouldStop()) stop()
    else {
      signal.addEventListener('abort', stop, { once: true })
      void inspectCardPage(tab).then(finish, stop)
    }
  })
}

/** Reuses the existing KeyMaster gates and persistent failed-attempt protection. */
export async function restoreCardSession(options: {
  tabs: TabManager
  tabId: string
  vault: VaultService
  settings: Settings
  signal: AbortSignal
}): Promise<CardSessionRestoreResult> {
  const { tabs, tabId, vault, settings, signal } = options
  const tab = tabs.get(tabId)
  const wc = tab?.view.webContents
  const issuer = wc && !wc.isDestroyed() && issuerForCardUrl(wc.getURL())
  const profile = tab?.profile
  const origin = issuer && wc ? new URL(wc.getURL()).origin : null
  const valid = (): boolean =>
    !!tab &&
    !!wc &&
    tabs.get(tabId) === tab &&
    typeof profile === 'string' &&
    profile.length > 0 &&
    tab.profile === profile &&
    tab.view.webContents === wc &&
    !wc.isDestroyed() &&
    !signal.aborted &&
    issuerForCardUrl(wc.getURL()) === issuer
  if (!tab || !issuer || !valid()) return { state: 'unavailable', auth: 'unknown' }
  const clearConfirmedLotteAttempts = (): void => {
    if (
      issuer !== 'lotte_card' ||
      !valid() ||
      typeof profile !== 'string' ||
      new URL(wc!.getURL()).origin !== origin
    )
      return
    try {
      // The keypad's short wait can finish before the site establishes its session.
      // Only the later verified session may reconcile both existing failure namespaces.
      lotteAttempts().clearSignedInProfile(profile)
      lotteKeypadAttempts().clearSignedInProfile(profile)
    } catch {
      // Storage failure retains protection; never reset or replace a failed record.
    }
  }
  const before = await inspectCardPage(tab)
  if (!valid() || before.state === 'navigation_changed' || before.issuer !== issuer)
    return { state: 'navigation_changed', auth: 'unknown' }
  if (before.auth === 'signed_in') {
    clearConfirmedLotteAttempts()
    return { state: 'already_signed_in', auth: 'signed_in' }
  }
  if (settings.permissionMode === 'read_only') return { state: 'read_only', auth: before.auth }
  tabs.focusTarget(tabId)
  if (!valid()) return { state: 'navigation_changed', auth: 'unknown' }
  const tools = createSambaTools({
    tabs,
    vault,
    mode: 'guard',
    finalConfirm: false,
    dangerWords: settings.dangerWords,
    confirm: async () => false,
    tick: () => (signal.aborted ? 'stopped' : null),
    onStep: () => undefined,
    jobId: 'finance-card-session',
    vaultAccessPolicy: settings.vaultAccessPolicy,
    vaultExcludedHosts: settings.vaultExcludedHosts,
    vaultAutoSubmit: settings.vaultAutoSubmit,
    vaultKeepSignedIn: settings.vaultKeepSignedIn
  })
  // This adapter exposes ONLY login; no generic agent tool or model execution.
  const alerts =
    issuer === 'samsung_card' ? await observeSamsungLoginAlerts(tab, { signal }) : undefined
  try {
    if (!valid()) return { state: 'navigation_changed', auth: 'unknown' }
    const result = await tools.tools.find((entry) => entry.name === 'login')!.handler({}, {})
    const raw = result.content.map((entry) => entry.text ?? '').join('\n')
    const waitForSamsung = issuer === 'samsung_card' && raw.startsWith('submitted:')
    const deadline = Date.now() + 25_000
    let auth: CardPageDiagnostics['auth'] = before.auth
    const terminalOutcome = (): string | undefined => {
      const outcome = alerts?.getOutcome()
      return outcome &&
        [
          'wrong_credentials',
          'input_required',
          'security_program_required',
          'additional_auth',
          'captcha'
        ].includes(outcome)
        ? outcome
        : undefined
    }
    // Samsung queues login behind netfunnel/AJAX: a click can finish before navigation
    // starts. Keep the same one-attempt alert observer alive while checking completion.
    for (;;) {
      if (!valid())
        return { state: signal.aborted ? 'cancelled' : 'navigation_changed', auth: 'unknown' }
      const after = waitForSamsung
        ? await inspectBeforeDeadline(tab, deadline, signal, () => !valid() || !!terminalOutcome())
        : await inspectCardPage(tab)
      if (!valid())
        return { state: signal.aborted ? 'cancelled' : 'navigation_changed', auth: 'unknown' }
      if (after && after.issuer !== issuer) return { state: 'navigation_changed', auth: 'unknown' }
      if (after?.state === 'navigation_changed' && !waitForSamsung)
        return { state: 'navigation_changed', auth: 'unknown' }
      if (after && after.state !== 'navigation_changed') {
        auth = after.auth
        if (after.auth === 'signed_in') {
          clearConfirmedLotteAttempts()
          return { state: 'signed_in', auth: 'signed_in' }
        }
      }
      const outcome = terminalOutcome()
      if (outcome) return { state: outcome, auth }
      if (!waitForSamsung || !after || Date.now() >= deadline)
        return { ...classifyLoginResult(raw), auth }
      await waitForSamsungStatus(Math.min(750, deadline - Date.now()), signal)
    }
  } finally {
    alerts?.dispose()
  }
}
