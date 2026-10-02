import type { TabManager } from '../browser/tab-manager'
import type { VaultService } from '../vault/service'
import type { Settings } from '../../shared/settings'
import { createSambaTools } from '../agent/tools'
import { issuerForCardUrl, inspectCardPage } from './card-page-diagnostics'

/** Reuses the existing KeyMaster gates and persistent failed-attempt protection. */
export async function restoreCardSession(options: {
  tabs: TabManager
  tabId: string
  vault: VaultService
  settings: Settings
  signal: AbortSignal
}): Promise<{ state: string; auth: string }> {
  const { tabs, tabId, vault, settings, signal } = options
  const tab = tabs.get(tabId)
  const issuer = tab && issuerForCardUrl(tab.view.webContents.getURL())
  const valid = (): boolean =>
    !!tab &&
    tabs.get(tabId) === tab &&
    !tab.view.webContents.isDestroyed() &&
    !signal.aborted &&
    issuerForCardUrl(tab.view.webContents.getURL()) === issuer
  if (!tab || !issuer || !valid()) return { state: 'unavailable', auth: 'unknown' }
  const before = await inspectCardPage(tab)
  if (!valid() || before.state === 'navigation_changed' || before.issuer !== issuer)
    return { state: 'navigation_changed', auth: 'unknown' }
  if (before.auth === 'signed_in') return { state: 'already_signed_in', auth: 'signed_in' }
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
  const result = await tools.tools.find((entry) => entry.name === 'login')!.handler({}, {})
  const after = await inspectCardPage(tab)
  if (!valid() || after.issuer !== issuer) return { state: 'navigation_changed', auth: 'unknown' }
  if (after.auth === 'signed_in') return { state: 'signed_in', auth: 'signed_in' }
  const raw = result.content.map((entry) => entry.text ?? '').join(' ')
  const state = /locked/i.test(raw)
    ? 'vault_locked'
    : /attempt|previous|failed|retry/i.test(raw)
      ? 'attempt_protected'
      : /needs_user|captcha|2fa/i.test(raw)
        ? 'user_verification_required'
        : /not found/i.test(raw)
          ? 'saved_account_unavailable'
          : /refused|denied|disabled/i.test(raw)
            ? 'policy_blocked'
            : 'login_unconfirmed'
  return { state, auth: after.auth }
}
