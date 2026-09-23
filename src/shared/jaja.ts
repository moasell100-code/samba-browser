// UI에는 이 목록의 메타데이터만 전달한다. 쿠키와 연결 키는 main에 남는다.
export type JajaIdentityState = 'unchecked' | 'verified' | 'unknown' | 'mismatch' | 'expired'
export type JajaSessionState = 'observe' | 'active' | 'paused' | 'released'

export interface JajaAccount {
  accountId: string
  site: string
  label: string
  usernameHint: string
  syncSupported: boolean
  syncBlockedReason?: string
}

export interface JajaSession {
  sessionId: string
  accountId: string
  site: string
  hostId: string
  state: JajaSessionState
  revision: number
  identityState: JajaIdentityState
  identityReason?: string
  observedAt?: string | null
  lastSyncedAt?: string | null
  providerSessionId: string | null
  syncSupported: boolean
  syncBlockedReason?: string
}

export interface JajaAccountView extends JajaAccount {
  session: JajaSession | null
  busy: boolean
  lastCheckedAt: string | null
  message: string
  autoLogin: boolean
  autoLoginSupported: boolean
  autoLoginBlockedReason?: string
  browserIdentityState?: JajaIdentityState
  browserIdentityReason?: string
}

export interface JajaStatus {
  validation?: boolean
  connected: boolean
  connecting: boolean
  backendOrigin: string
  hostId: string
  accounts: JajaAccountView[]
  error: string | null
}

export interface JajaCookieResult {
  sessionId: string
  mode: 'observe' | 'sync'
  revision: number
  identityState: JajaIdentityState
  accepted: boolean
  synced: boolean
  reason?: string
  lastSyncedAt?: string | null
}

export interface JajaSignal {
  sessionId: string
  kind: 'relogin' | 'refresh'
  reason?: string
}
