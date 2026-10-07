import type { AgentRunner } from '../agent/runner'
import type { Tab, TabManager } from '../browser/tab-manager'
import type { VaultService } from '../vault/service'
import type { Settings } from '../../shared/settings'
import type {
  CardDailyIssuer,
  CardDailyReason,
  CardDailyResult,
  CardDailyStatus,
  CardDailyStage
} from '../../shared/card-daily'
import { CARD_DAILY_ISSUERS } from '../../shared/card-daily'
import { createCardAgentSync } from './card-agent-sync'
import { CARD_HISTORY_URLS, inspectCardPage, issuerForCardUrl } from './card-page-diagnostics'
import { restoreCardSession } from './card-login-session'
import { CardDailyScheduler } from './card-daily-scheduler'
import { FileCardDailyStore } from './card-daily-store'
import { reportCardSchedule } from './card-schedule-report'
import { reconcileKnownCards } from './card-reconciliation-sync'
import { recoverCardCoverage } from './card-coverage-sync'
import { collectHyundaiApi } from './hyundai-api-collector'
import { collectSamsungApi } from './samsung-api-collector'
import { collectLotteApi } from './lotte-api-collector'
import {
  classifyCardNavigationFailure,
  classifyCardNavigationException
} from './card-navigation-failure'

const ISSUER_TIMEOUT_MS = 10 * 60_000
const SAMSUNG_LOGIN_URL = 'https://www.samsungcard.com/personal/login/UHPPCO0301M0.jsp'
const LOGIN_PATHS: Readonly<Record<CardDailyIssuer, string>> = {
  hyundai_card: '/index.jsp',
  samsung_card: '/personal/login/UHPPCO0301M0.jsp',
  lotte_card: '/app/LPMANAA_V200.lc'
}

function samsungLoginRedirect(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      issuerForCardUrl(value) === 'samsung_card' &&
      url.origin + url.pathname === SAMSUNG_LOGIN_URL &&
      !!url.search
    )
  } catch {
    return false
  }
}

function knownLoginEntry(value: string, issuer: CardDailyIssuer): boolean {
  if (issuerForCardUrl(value) !== issuer) return false
  try {
    const url = new URL(value)
    return (
      !url.search &&
      [new URL(CARD_HISTORY_URLS[issuer]).pathname, LOGIN_PATHS[issuer]].includes(url.pathname)
    )
  } catch {
    return false
  }
}

function interrupted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = (): void => {
      signal.removeEventListener('abort', stop)
      reject(new Error('Card schedule interrupted'))
    }
    if (signal.aborted) {
      stop()
      return
    }
    signal.addEventListener('abort', stop, { once: true })
    void work.then(
      (value) => {
        signal.removeEventListener('abort', stop)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop)
        reject(error)
      }
    )
  })
}

async function waitForHistoryDocument(
  wc: Tab['view']['webContents'],
  issuer: CardDailyIssuer,
  signal: AbortSignal,
  valid: () => boolean,
  canonicalUrl?: string
): Promise<boolean> {
  const deadline = Date.now() + 20_000
  let committed = false
  for (;;) {
    if (signal.aborted || !valid() || wc.isDestroyed())
      throw new Error('Card navigation interrupted')
    const url = wc.getURL()
    if (issuerForCardUrl(url) === issuer) {
      committed = true
      const current = new URL(url)
      if (canonicalUrl && current.origin + current.pathname !== canonicalUrl)
        throw new Error('Card login entry changed')
      if (
        !wc.isLoading() &&
        (!canonicalUrl || (!current.search && current.origin + current.pathname === canonicalUrl))
      )
        return true
    } else if (url !== 'about:blank' || committed) {
      throw new Error('Card navigation changed')
    }
    if (Date.now() >= deadline) return false
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, Math.min(250, deadline - Date.now()))
      if (signal.aborted) done()
      else signal.addEventListener('abort', done, { once: true })
    })
  }
}
function loginReason(state: string): CardDailyReason {
  if (state === 'attempt_protected') return 'attempt_protected'
  if (state === 'vault_locked') return 'vault_locked'
  if (['policy_blocked', 'read_only'].includes(state)) return 'policy_blocked'
  if (state === 'navigation_changed') return 'navigation_changed'
  if (
    [
      'user_verification_required',
      'wrong_credentials',
      'input_required',
      'security_program_required',
      'additional_auth',
      'captcha'
    ].includes(state)
  )
    return 'user_verification_required'
  return 'login_unconfirmed'
}

async function settledAuth(
  tab: Tab,
  signal: AbortSignal
): Promise<Awaited<ReturnType<typeof inspectCardPage>>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  const waiting = AbortSignal.any([signal, controller.signal])
  try {
    for (;;) {
      const state = await interrupted(inspectCardPage(tab), waiting)
      if (state.auth !== 'unknown') return state
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer)
          waiting.removeEventListener('abort', done)
          resolve()
        }
        const timer = setTimeout(done, 250)
        if (waiting.aborted) done()
        else waiting.addEventListener('abort', done, { once: true })
      })
      if (waiting.aborted) return state
    }
  } finally {
    clearTimeout(timeout)
  }
}

export function createCardDailyRuntime(options: {
  tabs: TabManager
  agent: Pick<AgentRunner, 'tryAcquireCardAutomation' | 'isRunning'>
  vault: VaultService
  settings(): Settings
  stateFile: string
  onChanged?(status: CardDailyStatus): void
  report?(status: CardDailyStatus): Promise<unknown>
}): CardDailyScheduler {
  // Own only tabs created here. Never navigate or close a user-owned card tab.
  const dedicated = new Map<CardDailyIssuer, string>()
  const lifetime = new AbortController()
  const report =
    options.report ??
    ((status: CardDailyStatus): Promise<boolean> =>
      reportCardSchedule(
        {
          enabled: status.enabled,
          hourKst: status.hourKst,
          phase: status.phase,
          runDate: status.runDate,
          startedAt: status.startedAt,
          finishedAt: status.finishedAt,
          gapDays: status.gapDays,
          results: (status.results.length
            ? status.results
            : CARD_DAILY_ISSUERS.map((issuer): CardDailyResult => ({
                issuer,
                state: 'pending',
                reason: status.reason
              }))
          ).map((row) => ({
            issuer: row.issuer,
            state: row.state === 'running' ? 'pending' : row.state,
            reason: row.reason ?? status.reason,
            approvalComplete: row.approvalComplete,
            cancellationComplete: row.cancellationComplete,
            complete: row.complete,
            insertedRows: row.insertedRows,
            updatedRows: row.updatedRows
          }))
        },
        {
          tokenFile: options.settings().financeCollectorTokenFile,
          transport: options.settings().financeCollectorTransport,
          signal: lifetime.signal
        }
      ))
  let lastReport = 0
  let lastReportShape = ''
  let reporting = false
  let pendingReport: CardDailyStatus | undefined
  const sendReport = (status: CardDailyStatus): void => {
    if (lifetime.signal.aborted) return
    if (reporting) {
      pendingReport = status
      return
    }
    reporting = true
    lastReportShape = JSON.stringify(status)
    lastReport = Date.now()
    void Promise.resolve()
      .then(() => report(status))
      .catch(() => undefined)
      .finally(() => {
        reporting = false
        const pending = pendingReport
        pendingReport = undefined
        if (pending && JSON.stringify(pending) !== lastReportShape) sendReport(pending)
      })
  }
  const publish = (status: CardDailyStatus): void => {
    options.onChanged?.(status)
    const shape = JSON.stringify(status)
    if (lifetime.signal.aborted || (shape === lastReportShape && Date.now() - lastReport < 300_000))
      return
    sendReport(status)
  }
  const policyReason = (): CardDailyReason | null => {
    const settings = options.settings()
    if (settings.permissionMode === 'read_only' || settings.vaultAccessPolicy === 'never')
      return 'policy_blocked'
    if (
      settings.financeCollectorTransport === 'disabled' ||
      (settings.financeCollectorTransport !== 'server-ssh' && !settings.financeCollectorTokenFile)
    )
      return 'not_configured'
    return null
  }
  const ready = async (signal: AbortSignal): Promise<CardDailyReason | null> => {
    const policy = policyReason()
    if (policy) return policy
    const configured = await createCardAgentSync({
      tokenFile: options.settings().financeCollectorTokenFile,
      transport: options.settings().financeCollectorTransport,
      signal
    })
    if (!configured) return 'not_configured'
    if (signal.aborted || !options.settings().financeDailyEnabled) return 'interrupted'
    if (policyReason()) return policyReason()
    if (options.vault.state() !== 'unlocked' && options.settings().vaultAccessPolicy === 'always')
      await options.vault.ensureUnlockedByDevice()
    return options.vault.state() === 'unlocked' ? null : 'vault_locked'
  }
  const run = async (
    issuer: CardDailyIssuer,
    parentSignal: AbortSignal,
    allowLogin: boolean
  ): Promise<CardDailyResult & { verifiedSignedIn?: boolean }> => {
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, parentSignal])
    let timeout = false
    const timer = setTimeout(() => {
      timeout = true
      controller.abort()
    }, ISSUER_TIMEOUT_MS)
    let tab: Tab | undefined
    let wc: Tab['view']['webContents'] | undefined
    let profile: string | undefined
    let opening = true
    let enteringCredentials = false
    let verifiedSignedIn = false
    let stage: CardDailyStage = 'prepare_tab'
    let loginAttempted = false
    let loadResult: NonNullable<CardDailyResult['navigationTrace']>['loadResult'] = 'not_started'
    const previousActive = options.tabs.active()?.id
    const guard = setInterval(() => {
      try {
        if (
          !options.settings().financeDailyEnabled ||
          options.agent.isRunning() ||
          policyReason() ||
          options.vault.state() !== 'unlocked' ||
          (tab &&
            (options.tabs.get(tab.id) !== tab ||
              tab.view.webContents !== wc ||
              tab.profile !== profile ||
              wc!.isDestroyed() ||
              (enteringCredentials && options.tabs.agentTarget()?.id !== tab.id) ||
              (!opening && issuerForCardUrl(wc!.getURL()) !== issuer)))
        )
          controller.abort()
      } catch {
        controller.abort()
      }
    }, 250)
    const releaseHold = options.vault.holdAutoLock('daily card collection')
    const stop = (): void => {
      try {
        if (wc && !wc.isDestroyed()) wc.stop()
      } catch {
        /* destroyed */
      }
    }
    signal.addEventListener('abort', stop, { once: true })
    try {
      if (signal.aborted) throw new Error()
      let existing = dedicated.get(issuer)
      if (existing) {
        const candidate = options.tabs.get(existing)
        if (
          !candidate ||
          candidate.view.webContents.isDestroyed() ||
          issuerForCardUrl(candidate.view.webContents.getURL()) !== issuer
        )
          existing = undefined
      }
      const created = !existing
      if (!existing) {
        existing = options.tabs.create({ url: 'about:blank', profile: 'default' }).id
        dedicated.set(issuer, existing)
      }
      tab = options.tabs.get(existing) ?? undefined
      if (!tab) throw new Error()
      wc = tab.view.webContents
      profile = tab.profile
      if (created) {
        // create() has already started a non-awaited blank navigation. Finish that document
        // before starting history navigation, just as the existing diagnostics runtime does.
        await interrupted(wc.loadURL('about:blank'), signal)
        if (wc.isDestroyed() || wc.getURL() !== 'about:blank') throw new Error()
      }
      stage = 'open_history'
      const navigation = wc.loadURL(CARD_HISTORY_URLS[issuer])
      if (!navigation || typeof navigation.then !== 'function') {
        loadResult = 'non_thenable'
        throw new Error('Card navigation returned no promise')
      }
      loadResult = 'promise'
      await interrupted(navigation, signal)
      loadResult = 'resolved'
      stage = 'verify_history_navigation'
      // Electron can resolve on a preceding about:blank did-finish-load. Observe the
      // actual committed document without issuing another request or weakening auth.
      const sameContext = (): boolean =>
        !!tab &&
        options.tabs.get(tab.id) === tab &&
        tab.view.webContents === wc &&
        tab.profile === profile
      if (!(await waitForHistoryDocument(wc, issuer, signal, sameContext))) {
        timeout = true
        throw new Error('Card navigation did not settle')
      }
      opening = false
      if (issuerForCardUrl(wc.getURL()) !== issuer) throw new Error()
      stage = 'inspect_session'
      let before = await interrupted(settledAuth(tab, signal), signal)
      if (before.issuer !== issuer) throw new Error()
      if (before.auth !== 'signed_in' && !allowLogin)
        return { issuer, state: 'needs_login', reason: 'attempt_protected', stage, loginAttempted }
      if (
        issuer === 'samsung_card' &&
        before.auth === 'unknown' &&
        before.state === 'unknown' &&
        samsungLoginRedirect(wc.getURL())
      ) {
        // An official QR/ID login redirect carries return parameters. Never follow or
        // forward their values: load the fixed public login entry once before native preparation.
        stage = 'prepare_login_page'
        await interrupted(wc.loadURL(SAMSUNG_LOGIN_URL), signal)
        if (!(await waitForHistoryDocument(wc, issuer, signal, sameContext, SAMSUNG_LOGIN_URL))) {
          timeout = true
          throw new Error('Card login entry did not settle')
        }
        stage = 'inspect_session'
        before = await interrupted(settledAuth(tab, signal), signal)
        if (before.issuer !== issuer) throw new Error()
      }
      if (
        before.auth === 'unsupported' ||
        (before.auth === 'unknown' &&
          (before.state !== 'unknown' || !knownLoginEntry(wc.getURL(), issuer)))
      )
        return { issuer, state: 'needs_login', reason: 'login_unconfirmed', stage, loginAttempted }
      if (before.auth !== 'signed_in') {
        // Exactly one existing login-tool invocation. Its failed-attempt stores are never reset.
        options.tabs.focusTarget(tab.id)
        enteringCredentials = true
        stage = 'restore_session'
        loginAttempted = true
        const login = await interrupted(
          restoreCardSession({
            tabs: options.tabs,
            tabId: tab.id,
            vault: options.vault,
            settings: options.settings(),
            signal
          }),
          signal
        )
        enteringCredentials = false
        if (login.auth !== 'signed_in')
          return {
            issuer,
            state: 'needs_login',
            reason: loginReason(login.state),
            stage,
            loginAttempted
          }
        stage = 'reopen_history'
        await interrupted(wc.loadURL(CARD_HISTORY_URLS[issuer]), signal)
        if (!(await waitForHistoryDocument(wc, issuer, signal, sameContext))) {
          timeout = true
          throw new Error('Card navigation did not settle')
        }
        stage = 'verify_restored_session'
        const confirmed = await interrupted(settledAuth(tab, signal), signal)
        if (confirmed.issuer !== issuer || confirmed.auth !== 'signed_in')
          return {
            issuer,
            state: 'needs_login',
            reason: 'login_unconfirmed',
            stage,
            loginAttempted
          }
      }
      if (
        signal.aborted ||
        options.tabs.get(tab.id) !== tab ||
        tab.view.webContents !== wc ||
        tab.profile !== profile ||
        wc.isDestroyed() ||
        issuerForCardUrl(wc.getURL()) !== issuer
      )
        throw new Error()
      verifiedSignedIn = true
      stage = 'prepare_sync'
      const sync = await createCardAgentSync({
        tokenFile: options.settings().financeCollectorTokenFile,
        transport: options.settings().financeCollectorTransport,
        signal
      })
      if (!sync)
        return {
          issuer,
          state: 'failed',
          reason: 'not_configured',
          verifiedSignedIn,
          stage,
          loginAttempted
        }
      stage = 'collect_save'
      const result = await interrupted(sync(tab), signal)
      if (!result.ok)
        return {
          issuer,
          verifiedSignedIn,
          stage,
          loginAttempted,
          state: result.reason === 'login_required' ? 'needs_login' : 'failed',
          reason:
            result.reason === 'login_required'
              ? 'login_required'
              : result.reason === 'collection_incomplete'
                ? 'collection_incomplete'
                : result.reason === 'interrupted'
                  ? 'interrupted'
                  : 'sync_unavailable'
        }
      const saved: CardDailyResult = {
        issuer,
        state: 'saved',
        stage,
        loginAttempted,
        approvalComplete: result.approvalComplete,
        cancellationComplete: result.cancellationComplete,
        complete: result.complete,
        totalRows: result.totalRows,
        insertedRows: result.insertedRows,
        updatedRows: result.updatedRows,
        reviewRows: result.reviewRows,
        ...(!result.approvalComplete
          ? { reason: 'collection_incomplete' as const }
          : result.reviewRows
            ? { reason: 'review_required' as const }
            : {})
      }
      if (result.approvalComplete) {
        stage = 'reconcile'
        try {
          await recoverCardCoverage(
            tab,
            {
              hyundai_card: collectHyundaiApi,
              samsung_card: collectSamsungApi,
              lotte_card: collectLotteApi
            }[issuer],
            {
              tokenFile: options.settings().financeCollectorTokenFile,
              transport: options.settings().financeCollectorTransport,
              signal
            }
          )
          saved.reconciliation = await interrupted(
            reconcileKnownCards(tab, {
              tokenFile: options.settings().financeCollectorTokenFile,
              transport: options.settings().financeCollectorTransport,
              signal
            }),
            signal
          )
        } catch {
          // A later check must never erase the receipt of an already saved current-period batch.
          saved.reconciliation = { state: 'failed', checkedDays: 0, reviewRows: 0, updatedRows: 0 }
        }
      }
      return { ...saved, verifiedSignedIn }
    } catch (error: unknown) {
      const navigationStage = [
        'open_history',
        'reopen_history',
        'prepare_tab',
        'prepare_login_page',
        'verify_history_navigation'
      ].includes(stage)
      const navigationFailure = navigationStage ? classifyCardNavigationFailure(error) : undefined
      let observedOrigin: NonNullable<CardDailyResult['navigationTrace']>['observedOrigin'] =
        'unavailable'
      if (navigationStage) {
        try {
          if (wc && !wc.isDestroyed()) {
            const url = wc.getURL()
            observedOrigin =
              url === 'about:blank'
                ? 'about_blank'
                : issuerForCardUrl(url) === issuer
                  ? 'expected_issuer'
                  : 'other'
          }
        } catch {
          /* a destroyed view has no current URL */
        }
      }
      const failureKind =
        navigationFailure?.category === 'aborted'
          ? 'navigation_aborted'
          : stage === 'open_history' ||
              stage === 'reopen_history' ||
              stage === 'prepare_tab' ||
              stage === 'prepare_login_page'
            ? 'navigation_failed'
            : 'operation_failed'
      return {
        issuer,
        verifiedSignedIn,
        stage,
        loginAttempted,
        failureKind,
        ...(navigationFailure ? { navigationFailure } : {}),
        ...(navigationStage
          ? {
              navigationTrace: {
                loadResult,
                observedOrigin,
                ...classifyCardNavigationException(error)
              }
            }
          : {}),
        state: 'failed',
        reason: timeout ? 'timeout' : signal.aborted ? 'interrupted' : 'sync_unavailable'
      }
    } finally {
      clearTimeout(timer)
      clearInterval(guard)
      signal.removeEventListener('abort', stop)
      controller.abort()
      releaseHold()
      if (
        previousActive &&
        tab &&
        options.tabs.active()?.id === tab.id &&
        options.tabs.get(previousActive)
      )
        options.tabs.focusTarget(previousActive)
    }
  }
  return new CardDailyScheduler({
    store: new FileCardDailyStore(options.stateFile),
    settings: options.settings,
    acquire: () => options.agent.tryAcquireCardAutomation(),
    ready,
    run,
    onChanged: publish,
    onDispose: () => lifetime.abort()
  })
}
