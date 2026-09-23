import { session, type Session, type WebContents, type WebFrameMain } from 'electron'
import type {
  JajaAccount,
  JajaAccountView,
  JajaIdentityState,
  JajaSession,
  JajaStatus
} from '../../shared/jaja'
import type { TabManager } from '../browser/tab-manager'
import { observeSessionRequests } from '../browser/request-hooks'
import { JajaApiError, JajaClient } from './client'
import { CaptureState, getSitePolicy, isKreamCookieExpired, type SitePolicy } from './policies'
import { probeSession } from './probe'
import { backendOrigin, frontendOrigin, JajaStore } from './store'

interface Context {
  account: JajaAccount
  remote: JajaSession
  policy: SitePolicy | null
  partition: string
  browser: Session
  capture: CaptureState | null
  busy: boolean
  lastCheckedAt: string | null
  message: string
  identity: JajaIdentityState
  nextCheck: number
  cookieGeneration: number
  debounce?: ReturnType<typeof setTimeout>
  dispose: () => void
}

export function paymentInProgress(url: string, popup = false): boolean {
  try {
    const parsed = new URL(url)
    return (
      popup ||
      /(?:^|\.)(?:pay|payment|checkout)\./i.test(parsed.hostname) ||
      /\/(?:checkout|payment|order-sheet|ordersheet|orderform|order-form|order\/create)(?:[/.?]|$)/i.test(
        parsed.pathname
      )
    )
  } catch {
    return popup
  }
}

function accountDto(account: JajaAccount): JajaAccount {
  return {
    accountId: String(account.accountId),
    site: String(account.site),
    label: String(account.label).slice(0, 100),
    usernameHint: String(account.usernameHint ?? '').slice(0, 100),
    syncSupported: account.syncSupported === true,
    syncBlockedReason: account.syncBlockedReason
  }
}

// Explicit allowlist: future server fields must never silently expose credentials to the UI.
function sessionDto(value: JajaSession): JajaSession {
  return {
    sessionId: value.sessionId,
    accountId: value.accountId,
    site: value.site,
    hostId: value.hostId,
    state: value.state,
    revision: value.revision,
    identityState: value.identityState,
    identityReason: value.identityReason,
    observedAt: value.observedAt,
    lastSyncedAt: value.lastSyncedAt,
    providerSessionId: value.providerSessionId,
    syncSupported: value.syncSupported === true,
    syncBlockedReason: value.syncBlockedReason
  }
}

export class JajaManager {
  private contexts = new Map<string, Context>()
  private client: JajaClient | null = null
  private error: string | null = null
  private stopped = false
  private refreshing = false
  private ticking = false
  private unlinking = false
  private writes: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setInterval>
  private pending: { wc: WebContents; origin: string; backend: string; expires: number } | null =
    null

  constructor(
    private store: JajaStore,
    private tabs: TabManager,
    private changed: (status: JajaStatus) => void,
    private makeSession: (partition: string) => Session = (partition) =>
      session.fromPartition(partition),
    private makeClient: (origin: string, hostId: string, key: () => string | null) => JajaClient = (
      origin,
      hostId,
      key
    ) => new JajaClient(origin, hostId, key)
  ) {
    this.timer = setInterval(() => {
      void this.tick()
    }, 30_000)
    this.timer.unref()
  }

  async start(): Promise<void> {
    try {
      if (this.store.key()) {
        this.client = this.makeClient(this.store.origin, this.store.hostId, () => this.store.key())
        await this.refresh()
      }
    } catch (error) {
      this.error = this.safeError(error)
      this.emit()
    }
  }

  status(): JajaStatus {
    const accounts: JajaAccountView[] = [...this.contexts.values()].map((ctx) => ({
      ...accountDto(ctx.account),
      session: sessionDto(ctx.remote),
      busy: ctx.busy,
      lastCheckedAt: ctx.lastCheckedAt,
      message: ctx.message,
      browserIdentityState: ctx.identity,
      browserIdentityReason: ctx.message,
      autoLogin: false,
      autoLoginSupported: false,
      autoLoginBlockedReason: 'manual_login_required'
    }))
    return {
      connected: !!this.client,
      connecting: !!this.pending && this.pending.expires > Date.now(),
      backendOrigin: this.store.origin,
      hostId: this.store.hostId,
      accounts,
      error: this.error
    }
  }

  connect(origin = this.store.origin): void {
    if (this.client) throw new Error('기존 연결을 해제한 뒤 다시 연결하세요.')
    const backend = backendOrigin(origin)
    const web = frontendOrigin(backend)
    const tab = this.tabs.createInSession({
      url: `${web}/samba/extension-link`,
      profile: '자자 연결',
      partition: `persist:jaja-control-${this.store.hostId}`
    })
    const wc = this.tabs.get(tab.id)?.view.webContents
    if (!wc) throw new Error('자자 연결 탭을 열지 못했습니다.')
    this.pending = { wc, origin: web, backend, expires: Date.now() + 10 * 60_000 }
    this.error = null
    this.emit()
  }

  private pairingAllowed(wc: WebContents, frame: WebFrameMain | null): boolean {
    const pending = this.pending
    if (
      !pending ||
      pending.expires <= Date.now() ||
      pending.wc !== wc ||
      wc.isDestroyed() ||
      frame !== wc.mainFrame
    )
      return false
    try {
      const url = new URL(frame.url)
      return url.origin === pending.origin && /^\/samba(?:\/|$)/.test(url.pathname)
    } catch {
      return false
    }
  }

  pairStatus(wc: WebContents, frame: WebFrameMain | null): { pending: boolean; hostId?: string } {
    return this.pairingAllowed(wc, frame)
      ? { pending: true, hostId: this.store.hostId }
      : { pending: false }
  }

  async pairKey(wc: WebContents, frame: WebFrameMain | null, key: unknown): Promise<void> {
    if (
      !this.pairingAllowed(wc, frame) ||
      typeof key !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(key)
    ) {
      throw new Error('승인된 자자 연결 탭에서만 연결할 수 있습니다.')
    }
    const pending = this.pending!
    try {
      // Check deployment and key/host binding before persisting a connection. A server
      // without these routes must not leave an unremovable half-connected local key.
      const candidate = this.makeClient(pending.backend, this.store.hostId, () => key)
      const [accounts] = await Promise.all([candidate.accounts(), candidate.sessions()])
      if (
        accounts.hostId !== this.store.hostId ||
        !this.pairingAllowed(wc, frame) ||
        this.pending !== pending
      ) {
        throw new Error('pairing_expired')
      }
      this.store.connect(pending.backend, key)
      this.pending = null
      this.client = this.makeClient(this.store.origin, this.store.hostId, () => this.store.key())
      this.emit()
      await this.refresh()
    } catch (error) {
      if (this.pending === pending) {
        this.pending = null
        this.error = this.safeError(error)
        this.emit()
      }
      throw new Error(this.safeError(error))
    }
  }

  async refresh(): Promise<JajaStatus> {
    const client = this.requiredClient()
    if (this.refreshing || this.unlinking) return this.status()
    this.refreshing = true
    try {
      const [accounts, sessions] = await Promise.all([client.accounts(), client.sessions()])
      if (this.stopped || client !== this.client) return this.status()
      if (accounts.hostId !== this.store.hostId)
        throw new Error('연결된 자자 기기가 일치하지 않습니다.')
      const seen = new Set<string>()
      for (const value of accounts.accounts) {
        const account = accountDto(value)
        seen.add(account.accountId)
        const current = this.contexts.get(account.accountId)
        let remote = sessions.sessions.find(
          (item) =>
            item.hostId === this.store.hostId &&
            String(item.accountId) === account.accountId &&
            item.state !== 'released'
        )
        remote ??= sessions.sessions.find(
          (item) =>
            item.hostId === this.store.hostId && String(item.accountId) === account.accountId
        )
        remote ??= await this.write(() =>
          client.register(account.accountId, this.store.sessionId(account.accountId))
        )
        if (this.stopped || client !== this.client) return this.status()
        this.validateSession(remote, account)
        this.store.rememberSession(account.accountId, remote.sessionId)
        if (current?.remote.sessionId === remote.sessionId) {
          current.account = account
          if (!current.busy) current.remote = sessionDto(remote)
        } else {
          current?.dispose()
          this.contexts.set(account.accountId, this.createContext(account, remote))
        }
      }
      for (const [id, ctx] of this.contexts) {
        if (!seen.has(id)) {
          ctx.dispose()
          this.contexts.delete(id)
        }
      }
      this.error = null
    } catch (error) {
      this.error = this.safeError(error)
      throw new Error(this.error)
    } finally {
      this.refreshing = false
      this.emit()
    }
    return this.status()
  }

  private validateSession(value: JajaSession, account: JajaAccount): void {
    if (
      value.hostId !== this.store.hostId ||
      String(value.accountId) !== account.accountId ||
      !/^[a-f0-9-]{36}$/i.test(value.sessionId) ||
      value.site !== account.site
    ) {
      throw new Error('계정과 브라우저 세션 연결이 일치하지 않습니다.')
    }
  }

  private createContext(account: JajaAccount, remote: JajaSession): Context {
    const partition = `persist:jaja-${remote.sessionId}`
    const browser = this.makeSession(partition)
    const policy = getSitePolicy(account.site)
    const capture = policy ? new CaptureState(policy.site) : null
    const ctx: Context = {
      account,
      remote: sessionDto(remote),
      policy,
      partition,
      browser,
      capture,
      busy: false,
      lastCheckedAt: null,
      message: 'login_required',
      identity: 'unchecked',
      nextCheck: Date.now() + 15_000,
      cookieGeneration: 0,
      dispose: () => {}
    }
    const disposeObserver = observeSessionRequests(
      browser,
      `jaja:${remote.sessionId}`,
      (details) => {
        if (capture?.record(details.url, details.requestHeaders)) {
          ctx.cookieGeneration++
          const wasVerified = ctx.identity === 'verified'
          ctx.identity = 'unknown'
          if (wasVerified) this.emit()
          this.schedule(ctx)
        }
      }
    )
    const cookieChanged = (): void => {
      // A captured old header must not revive a cookie deleted by logout or account switching.
      capture?.reset()
      ctx.cookieGeneration++
      const wasVerified = ctx.identity === 'verified'
      ctx.identity = 'unknown'
      if (wasVerified) this.emit()
      this.schedule(ctx)
    }
    browser.cookies.on('changed', cookieChanged)
    ctx.dispose = () => {
      disposeObserver()
      browser.cookies.removeListener('changed', cookieChanged)
      clearTimeout(ctx.debounce)
    }
    return ctx
  }

  private schedule(ctx: Context): void {
    if (
      this.stopped ||
      this.unlinking ||
      ctx.debounce ||
      ctx.busy ||
      !['observe', 'active'].includes(ctx.remote.state)
    )
      return
    ctx.debounce = setTimeout(() => {
      ctx.debounce = undefined
      if (Date.now() >= ctx.nextCheck) void this.check(ctx.account.accountId).catch(() => {})
    }, 3000)
  }

  open(accountId: string): void {
    const ctx = this.context(accountId)
    if (!ctx.policy) throw new Error('아직 지원하지 않는 소싱처입니다.')
    const existing = this.tabs
      .list()
      .find((tab) => this.tabs.get(tab.id)?.view.webContents.session === ctx.browser)
    if (existing) this.tabs.focusTarget(existing.id)
    else
      this.tabs.createInSession({
        url: ctx.policy.homeUrl,
        profile: `${ctx.account.site} · ${ctx.account.label}`,
        partition: ctx.partition
      })
  }

  private protected(ctx: Context): boolean {
    return this.tabs.listAll().some((tab) => {
      if (tab.kind === 'popup') {
        // Conservative while a popup is open: purchases must not be disturbed by probes.
        return true
      }
      return (
        this.tabs.get(tab.id)?.view.webContents.session === ctx.browser &&
        paymentInProgress(tab.url)
      )
    })
  }

  async check(accountId: string): Promise<JajaStatus> {
    const ctx = this.context(accountId)
    if (ctx.busy || this.unlinking) return this.status()
    const client = this.requiredClient()
    ctx.busy = true
    this.emit()
    try {
      ctx.remote = sessionDto(await client.session(ctx.remote.sessionId))
      this.validateSession(ctx.remote, ctx.account)
      if (this.stopped || !this.contexts.has(accountId)) return this.status()
      if (!ctx.policy || !ctx.capture || ctx.policy.kind === 'page' || !ctx.remote.syncSupported) {
        ctx.message = ctx.remote.syncBlockedReason || 'site_not_supported'
        return this.status()
      }
      if (this.protected(ctx)) {
        ctx.message = 'payment_in_progress'
        return this.status()
      }
      const probe = await probeSession(ctx.policy, (url, init) => ctx.browser.fetch(url, init))
      if (this.stopped || !this.contexts.has(accountId)) return this.status()
      if (probe.state === 'expired') {
        ctx.capture.reset()
        ctx.identity = 'expired'
        ctx.message = 'login_expired'
        return this.status()
      }
      // 29CM's users/me may rotate tokens, so read the jar only after the probe.
      const generation = ctx.cookieGeneration
      const jar = await ctx.browser.cookies.get({})
      if (generation !== ctx.cookieGeneration) {
        ctx.identity = 'unknown'
        ctx.message = 'cookies_changed'
        return this.status()
      }
      const candidate = ctx.capture.build(jar)
      if (!candidate.cookie) {
        ctx.identity = 'unknown'
        ctx.message = candidate.reason || 'login_required'
        return this.status()
      }
      if (ctx.policy.site === 'KREAM' && isKreamCookieExpired(candidate.cookie) === true) {
        ctx.identity = 'expired'
        ctx.message = 'login_expired'
        return this.status()
      }
      if (
        this.stopped ||
        this.contexts.get(accountId) !== ctx ||
        this.protected(ctx) ||
        generation !== ctx.cookieGeneration
      )
        return this.status()
      const result = await this.write(() => {
        if (
          generation !== ctx.cookieGeneration ||
          this.contexts.get(accountId) !== ctx ||
          this.protected(ctx)
        ) {
          throw new Error('cookies_changed')
        }
        return client.cookies(ctx.remote, candidate.cookie, {
          source: candidate.source,
          capturedAt: candidate.capturedAt,
          browserState: probe.state,
          ...probe.extra
        })
      })
      ctx.remote = {
        ...ctx.remote,
        revision: result.revision,
        identityState: result.identityState,
        identityReason: result.reason,
        lastSyncedAt: result.lastSyncedAt ?? ctx.remote.lastSyncedAt
      }
      ctx.identity = generation === ctx.cookieGeneration ? result.identityState : 'unknown'
      ctx.message =
        generation !== ctx.cookieGeneration
          ? 'cookies_changed'
          : result.synced
            ? 'synced'
            : result.accepted
              ? 'observed'
              : result.reason || 'verification_failed'
      await ctx.browser.cookies.flushStore()
    } catch (error) {
      ctx.identity = 'unknown'
      ctx.message =
        error instanceof JajaApiError && error.status === 409
          ? 'state_changed'
          : 'connection_failed'
      throw new Error(this.safeError(error))
    } finally {
      ctx.busy = false
      ctx.lastCheckedAt = new Date().toISOString()
      ctx.nextCheck = Date.now() + 5 * 60_000
      this.emit()
    }
    return this.status()
  }

  async action(accountId: string, action: 'activate' | 'pause' | 'release'): Promise<JajaStatus> {
    const ctx = this.context(accountId)
    if (ctx.busy || this.unlinking) throw new Error('계정 확인이 끝난 뒤 다시 진행하세요.')
    const client = this.requiredClient()
    if (action === 'activate' && (ctx.identity !== 'verified' || this.protected(ctx))) {
      throw new Error('로그인 계정을 다시 확인한 뒤 동기화로 전환하세요.')
    }
    ctx.busy = true
    this.emit()
    try {
      // Use the revision and previous owner that the user actually reviewed, not a silent refresh.
      ctx.remote = sessionDto(
        await this.write(() => {
          if (
            this.contexts.get(accountId) !== ctx ||
            (action === 'activate' && (ctx.identity !== 'verified' || this.protected(ctx)))
          ) {
            throw new Error('로그인 계정을 다시 확인한 뒤 동기화로 전환하세요.')
          }
          return client[action](ctx.remote)
        })
      )
      ctx.message = ctx.remote.state
    } finally {
      ctx.busy = false
      this.emit()
    }
    if (action === 'activate') return this.check(accountId)
    return this.status()
  }

  setAutoLogin(_accountId: string, _enabled: boolean): JajaStatus {
    throw new Error('이 버전은 직접 로그인한 세션을 유지합니다. 자동 재로그인은 지원하지 않습니다.')
  }

  async disconnect(): Promise<JajaStatus> {
    if (this.refreshing || [...this.contexts.values()].some((ctx) => ctx.busy)) {
      throw new Error('진행 중인 계정 확인이 끝난 뒤 연결을 해제하세요.')
    }
    this.unlinking = true
    try {
      if (this.client) {
        // Refresh remote ownership first; a hidden or locally missing session may still own writes.
        const { sessions } = await this.client.sessions()
        for (const remote of sessions) {
          if (remote.hostId === this.store.hostId && ['active', 'paused'].includes(remote.state)) {
            await this.write(() => this.client!.release(remote))
          }
        }
      }
      this.store.disconnect()
      for (const ctx of this.contexts.values()) ctx.dispose()
      this.contexts.clear()
      this.client = null
      this.pending = null
      this.error = null
    } finally {
      this.unlinking = false
      this.emit()
    }
    return this.status()
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped || this.unlinking || !this.client) return
    this.ticking = true
    try {
      const { signals } = await this.client.signals()
      for (const signal of signals) {
        const ctx = [...this.contexts.values()].find(
          (item) => item.remote.sessionId === signal.sessionId
        )
        if (!ctx) continue
        if (signal.kind === 'relogin') {
          ctx.message = 'login_required'
          ctx.identity = 'unknown'
          // Check this browser before declaring its login expired from a server-only signal.
          if (!ctx.lastCheckedAt || Date.now() - Date.parse(ctx.lastCheckedAt) >= 60_000)
            ctx.nextCheck = 0
        } else ctx.nextCheck = 0
      }
      for (const ctx of this.contexts.values()) {
        if (this.stopped || this.unlinking) break
        if (
          ['active', 'observe'].includes(ctx.remote.state) &&
          !ctx.busy &&
          Date.now() >= ctx.nextCheck
        ) {
          await this.check(ctx.account.accountId).catch(() => {})
        }
      }
    } catch {
      this.error = '자자 서버 상태를 확인하지 못했습니다. 기존 로그인 세션은 유지됩니다.'
    } finally {
      this.ticking = false
      this.emit()
    }
  }

  private context(accountId: string): Context {
    if (typeof accountId !== 'string') throw new Error('계정을 선택하세요.')
    const ctx = this.contexts.get(accountId)
    if (!ctx) throw new Error('연결된 계정을 찾을 수 없습니다. 목록을 새로고침하세요.')
    return ctx
  }
  private write<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.writes.then(() => {
      if (this.stopped) throw new Error('browser_closed')
      return operation()
    })
    this.writes = task.then(
      () => {},
      () => {}
    )
    return task
  }
  private requiredClient(): JajaClient {
    if (!this.client || this.stopped) throw new Error('자자 연결이 필요합니다.')
    return this.client
  }
  private safeError(error: unknown): string {
    return error instanceof JajaApiError
      ? error.message
      : '자자 연결 상태를 확인하세요. 기존 쿠키는 유지됩니다.'
  }
  private emit(): void {
    if (!this.stopped) this.changed(this.status())
  }
  dispose(): void {
    this.stopped = true
    clearInterval(this.timer)
    for (const ctx of this.contexts.values()) ctx.dispose()
    this.pending = null
  }
}
