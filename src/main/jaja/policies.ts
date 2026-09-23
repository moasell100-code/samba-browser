/**
 * JAJA extension session policies, without Electron, storage, network, or AI access.
 * Create one CaptureState per account partition. Never share one between accounts.
 * A cookie candidate is not proof of authentication: the server remains authoritative.
 * Sources: extension/background.js, background-{bootstrap,cm29-session,abcmart-session}.js.
 */
export type JajaSite =
  | 'MUSINSA'
  | 'KREAM'
  | 'LOTTEON'
  | 'SSG'
  | 'NAVER'
  | '29CM'
  | 'ABCMART'
  | 'SNKRDUNK'
  | 'REXMONDE'
  | 'BUNJANG'

export interface SitePolicy {
  readonly site: JajaSite
  readonly serverSite: string | null
  readonly homeUrl: string
  readonly capturePatterns: readonly string[]
  readonly kind: 'cookie' | 'page'
  readonly probe?: {
    readonly url: string
    readonly kind: 'json-identity' | 'redirect' | 'page'
  }
  readonly requiresPostProbeRead: boolean
  readonly autoRelogin: boolean
}

const MUSINSA_HOSTS = [
  'www.musinsa.com',
  'api.musinsa.com',
  'order.musinsa.com',
  'goods.musinsa.com',
  'my.musinsa.com'
] as const
const NAVER_HOSTS = [
  'brand.naver.com',
  'smartstore.naver.com',
  'shopping.naver.com',
  'nid.naver.com'
] as const

export const SITE_POLICIES: Readonly<Record<JajaSite, SitePolicy>> = {
  MUSINSA: {
    site: 'MUSINSA',
    serverSite: 'musinsa',
    homeUrl: 'https://www.musinsa.com/',
    capturePatterns: MUSINSA_HOSTS.map((host) => `https://${host}/*`),
    kind: 'cookie',
    probe: { url: 'https://www.musinsa.com/mypage/myreview', kind: 'redirect' },
    requiresPostProbeRead: false,
    autoRelogin: true
  },
  KREAM: {
    site: 'KREAM',
    serverSite: 'kream',
    homeUrl: 'https://kream.co.kr/',
    capturePatterns: ['https://*.kream.co.kr/*'],
    kind: 'cookie',
    probe: { url: 'https://kream.co.kr/my/reviews?tab=to_write', kind: 'page' },
    requiresPostProbeRead: false,
    autoRelogin: true
  },
  LOTTEON: {
    site: 'LOTTEON',
    serverSite: 'lotteon',
    homeUrl: 'https://www.lotteon.com/',
    capturePatterns: ['https://*.lotteon.com/*'],
    kind: 'cookie',
    probe: {
      url: 'https://www.lotteon.com/p/review/myLotte/reviewWriteListTab',
      kind: 'redirect'
    },
    requiresPostProbeRead: false,
    autoRelogin: true
  },
  SSG: {
    site: 'SSG',
    serverSite: 'ssg',
    homeUrl: 'https://www.ssg.com/',
    capturePatterns: ['https://*.ssg.com/*'],
    kind: 'cookie',
    // This browser check is not the server's pay.ssg.com order-list check.
    probe: {
      url: 'https://www.ssg.com/myssg/activityMng/pdtEvalList.ssg?quick=pdtEvalList',
      kind: 'redirect'
    },
    requiresPostProbeRead: false,
    autoRelogin: true
  },
  NAVER: {
    site: 'NAVER',
    serverSite: 'naver',
    homeUrl: 'https://shopping.naver.com/',
    capturePatterns: [
      ...NAVER_HOSTS.map((host) => `https://${host}/*`),
      'https://*.pay.naver.com/*'
    ],
    kind: 'cookie',
    requiresPostProbeRead: false,
    autoRelogin: false
  },
  '29CM': {
    site: '29CM',
    serverSite: '29cm',
    homeUrl: 'https://www.29cm.co.kr/',
    capturePatterns: ['https://*.29cm.co.kr/*'],
    kind: 'cookie',
    probe: { url: 'https://user-api.29cm.co.kr/api/v4/users/me', kind: 'json-identity' },
    requiresPostProbeRead: true,
    // Existing JAJA policy: a 29CM relogin can replace the Musinsa SSO session.
    autoRelogin: false
  },
  ABCMART: {
    site: 'ABCMART',
    serverSite: 'abcmart',
    homeUrl: 'https://abcmart.a-rt.com/',
    capturePatterns: ['https://*.a-rt.com/*'],
    kind: 'cookie',
    // Only in a same-origin tab. A generic background fetch may create a guest session.
    probe: { url: 'https://abcmart.a-rt.com/mypage', kind: 'page' },
    requiresPostProbeRead: false,
    autoRelogin: true
  },
  SNKRDUNK: {
    site: 'SNKRDUNK',
    serverSite: 'orders/snkrdunk',
    homeUrl: 'https://snkrdunk.com/',
    capturePatterns: ['https://*.snkrdunk.com/*'],
    kind: 'cookie',
    requiresPostProbeRead: false,
    autoRelogin: false
  },
  REXMONDE: {
    site: 'REXMONDE',
    serverSite: null,
    homeUrl: 'https://www.rexmonde.com/',
    capturePatterns: [],
    kind: 'page',
    probe: { url: 'https://www.rexmonde.com/mypage/order_list', kind: 'page' },
    requiresPostProbeRead: false,
    autoRelogin: true
  },
  BUNJANG: {
    site: 'BUNJANG',
    serverSite: null,
    homeUrl: 'https://m.bunjang.co.kr/',
    capturePatterns: [],
    kind: 'page',
    requiresPostProbeRead: false,
    autoRelogin: false
  }
}

const ALIASES: Readonly<Record<string, JajaSite>> = {
  MUSINSA: 'MUSINSA',
  무신사: 'MUSINSA',
  KREAM: 'KREAM',
  크림: 'KREAM',
  LOTTEON: 'LOTTEON',
  롯데온: 'LOTTEON',
  SSG: 'SSG',
  NAVER: 'NAVER',
  NAVERSTORE: 'NAVER',
  SMARTSTORE: 'NAVER',
  네이버: 'NAVER',
  '29CM': '29CM',
  CM29: '29CM',
  ABCMART: 'ABCMART',
  ABC마트: 'ABCMART',
  GRANDSTAGE: 'ABCMART',
  그랜드스테이지: 'ABCMART',
  SNKRDUNK: 'SNKRDUNK',
  스니커덩크: 'SNKRDUNK',
  REXMONDE: 'REXMONDE',
  렉스몬드: 'REXMONDE',
  BUNJANG: 'BUNJANG',
  번개장터: 'BUNJANG'
}

export function normalizeSite(input: string): JajaSite | null {
  return (
    ALIASES[
      input
        .trim()
        .replace(/[\s_-]/g, '')
        .toUpperCase()
    ] ?? null
  )
}

export function getSitePolicy(input: string): SitePolicy | null {
  const site = normalizeSite(input)
  return site ? SITE_POLICIES[site] : null
}

const inDomain = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`)

function allowedHost(site: JajaSite, host: string, cookieDomain = false): boolean {
  switch (site) {
    case 'MUSINSA':
      return (
        MUSINSA_HOSTS.some((allowed) => host === allowed) ||
        (cookieDomain && host === 'musinsa.com')
      )
    case 'NAVER':
      return (
        NAVER_HOSTS.some((allowed) => host === allowed) ||
        inDomain(host, 'pay.naver.com') ||
        (cookieDomain && host === 'naver.com')
      )
    case 'KREAM':
      return inDomain(host, 'kream.co.kr')
    case 'LOTTEON':
      return inDomain(host, 'lotteon.com')
    case 'SSG':
      return inDomain(host, 'ssg.com')
    case '29CM':
      return inDomain(host, '29cm.co.kr')
    case 'ABCMART':
      return inDomain(host, 'a-rt.com')
    case 'SNKRDUNK':
      return inDomain(host, 'snkrdunk.com')
    default:
      return false
  }
}

export function matchesCaptureUrl(site: JajaSite, rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      allowedHost(site, url.hostname)
    )
  } catch {
    return false
  }
}

export interface JarCookie {
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  expirationDate?: number
}

export type CaptureHeaders =
  Record<string, string | string[] | undefined> | ReadonlyArray<{ name: string; value?: string }>

export interface CookieCandidate {
  cookie: string
  source: 'captured' | 'jar' | 'none'
  reason?: string
  /** Owner hint only; never a raw authentication token. */
  identity?: string
  capturedAt?: number
  requiresVerification: boolean
  requiresPostProbeRead: boolean
}

export function parseCookieHeader(header: string): Map<string, string> {
  const parsed = new Map<string, string>()
  if (/[\r\n]/.test(header)) return parsed
  for (const part of header.split(';')) {
    const delimiter = part.indexOf('=')
    if (delimiter <= 0) continue
    const name = part.slice(0, delimiter).trim()
    const value = part.slice(delimiter + 1).trim()
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue
    if (!parsed.has(name)) parsed.set(name, value)
  }
  return parsed
}

const serialize = (cookies: Map<string, string>): string =>
  [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')

function cookieHeader(headers: CaptureHeaders): string {
  const values = Array.isArray(headers)
    ? headers
        .filter((header) => header.name.toLowerCase() === 'cookie')
        .map((header) => header.value)
    : Object.entries(headers)
        .filter(([name]) => name.toLowerCase() === 'cookie')
        .flatMap(([, value]) => value)
  return values.filter((value): value is string => typeof value === 'string').join('; ')
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Same ownership key as JAJA's _musinsa_jwt.py. This does not verify the signature. */
export function extractMusinsaIdentity(cookie: string): string | null {
  const token = parseCookieHeader(cookie).get('mss_mac')
  const sub = token ? decodeJwtPayload(token)?.sub : null
  return typeof sub === 'string' && sub ? sub : null
}

export interface Cm29Identity {
  userId: string | number
  loginId: string
}

export function parseCm29Identity(payload: unknown): Cm29Identity | null {
  if (!payload || typeof payload !== 'object') return null
  const data = (payload as { data?: unknown }).data
  if (!data || typeof data !== 'object') return null
  const { userId, loginId } = data as { userId?: unknown; loginId?: unknown }
  if (
    (typeof userId !== 'string' && typeof userId !== 'number') ||
    !userId ||
    (typeof userId === 'number' && !Number.isFinite(userId))
  ) {
    return null
  }
  return { userId, loginId: typeof loginId === 'string' ? loginId.slice(0, 64) : '' }
}

const EMPTY_TOKENS = new Set(['', 'false', 'null', 'undefined', 'true'])

export function isKreamCookieLoggedOut(cookie: string): boolean {
  const tokens = [...parseCookieHeader(cookie)].filter(([name]) => name.startsWith('_token.'))
  return tokens.length > 0 && tokens.every(([, value]) => EMPTY_TOKENS.has(value.toLowerCase()))
}

export function getKreamTokenExpiryMs(cookie: string): number | null {
  for (const [name, value] of parseCookieHeader(cookie)) {
    if (!name.startsWith('_token.') || EMPTY_TOKENS.has(value.toLowerCase())) continue
    try {
      let token = decodeURIComponent(value)
      if (token.startsWith('{')) {
        const wrapped = JSON.parse(token) as { access_token?: unknown; token?: unknown }
        const unwrapped = wrapped.access_token ?? wrapped.token
        if (typeof unwrapped !== 'string') continue
        token = unwrapped
      }
      const exp = decodeJwtPayload(token)?.exp
      if (typeof exp === 'number' && Number.isFinite(exp) && exp > 0) return exp * 1000
    } catch {
      // Try another strategy cookie. A malformed token is unknown, not logged out.
    }
  }
  return null
}

export function isKreamCookieExpired(cookie: string, now = Date.now()): boolean | null {
  if (isKreamCookieLoggedOut(cookie)) return true
  const expiry = getKreamTokenExpiryMs(cookie)
  return expiry === null ? null : expiry <= now
}

export function needsKreamRefresh(cookie: string, now = Date.now()): boolean {
  const expiry = getKreamTokenExpiryMs(cookie)
  return expiry === null || expiry - now <= 15 * 60 * 1000
}

const ABC_SESSION_NAME = /^(JSESSIONID|SESSION|.*(?:SESSID|AUTH|TOKEN).*)$/i
const ABC_CAPTURE_MAX_AGE_MS = 30 * 60 * 1000
const hasAbcSession = (cookie: string): boolean =>
  [...parseCookieHeader(cookie)].some(([name, value]) => ABC_SESSION_NAME.test(name) && !!value)

export class CaptureState {
  private byHost = new Map<string, string>()
  private tokenIdentity = ''
  private ssgAuthPair = new Map<string, string>()
  private latest = ''
  private latestAt: number | undefined

  constructor(readonly site: JajaSite) {}

  reset(): void {
    this.byHost.clear()
    this.tokenIdentity = ''
    this.ssgAuthPair.clear()
    this.latest = ''
    this.latestAt = undefined
  }

  record(url: string, headers: CaptureHeaders, now = Date.now()): boolean {
    if (!matchesCaptureUrl(this.site, url)) return false
    let cookie = serialize(parseCookieHeader(cookieHeader(headers)))
    if (!cookie) return false
    const parsed = parseCookieHeader(cookie)
    if (this.site === 'MUSINSA') {
      const token = parsed.get('mss_mac')
      if (token && token !== this.tokenIdentity) {
        this.byHost.clear()
        this.tokenIdentity = token
      }
      this.byHost.set(new URL(url).hostname, cookie)
      const merged = new Map<string, string>()
      for (const host of MUSINSA_HOSTS) {
        for (const [name, value] of parseCookieHeader(this.byHost.get(host) ?? '')) {
          if (!merged.has(name)) merged.set(name, value)
        }
      }
      cookie = serialize(merged)
    } else if (this.site === 'SSG') {
      if (parsed.get('FS0') && parsed.get('FS1')) {
        this.ssgAuthPair = new Map([
          ['FS0', parsed.get('FS0')!],
          ['FS1', parsed.get('FS1')!]
        ])
      }
      for (const name of ['FS0', 'FS1']) {
        if (!parsed.get(name) && this.ssgAuthPair.has(name)) {
          parsed.set(name, this.ssgAuthPair.get(name)!)
        }
      }
      if (!parsed.get('FS0') || !parsed.get('FS1')) return false
      cookie = serialize(parsed)
    } else if (this.site === 'ABCMART' && !hasAbcSession(cookie)) {
      return false
    } else if (this.site === 'SNKRDUNK') {
      const session = parsed.get('session')
      if (!session) return false
      cookie = serialize(new Map([['session', session]]))
    }
    // Timestamp is refreshed even when the value is unchanged: it was just observed.
    const changed = cookie !== this.latest
    this.latest = cookie
    this.latestAt = now
    return changed
  }

  private jarHeader(jar: readonly JarCookie[], now: number): string {
    const byName = new Map<string, JarCookie>()
    for (const cookie of jar) {
      const domain = cookie.domain?.replace(/^\./, '').toLowerCase()
      if (!domain || !allowedHost(this.site, domain, true)) continue
      if (cookie.expirationDate !== undefined && cookie.expirationDate * 1000 <= now) continue
      if (/[;\r\n]/.test(cookie.value) || /[;=\r\n]/.test(cookie.name)) continue
      const previous = byName.get(cookie.name)
      if (!previous || (cookie.path ?? '').length > (previous.path ?? '').length) {
        byName.set(cookie.name, cookie)
      }
    }
    return serialize(new Map([...byName.values()].map((cookie) => [cookie.name, cookie.value])))
  }

  build(jar: readonly JarCookie[] = [], now = Date.now()): CookieCandidate {
    const policy = SITE_POLICIES[this.site]
    const candidate: CookieCandidate = {
      cookie: '',
      source: 'none',
      requiresVerification: policy.kind === 'cookie',
      requiresPostProbeRead: policy.requiresPostProbeRead
    }
    if (policy.kind === 'page') return { ...candidate, reason: 'page_only' }
    const jarHeader = this.jarHeader(jar, now)
    let selected = this.latest || jarHeader
    let source: CookieCandidate['source'] = this.latest ? 'captured' : 'jar'
    if (this.site === '29CM') {
      // Preserve the extension's dual-source candidate selection. The users/me probe and
      // server verification, not cookie names or count, decide whether it is authenticated.
      if (parseCookieHeader(jarHeader).size >= parseCookieHeader(this.latest).size) {
        selected = jarHeader
        source = 'jar'
      }
    } else if (this.site === 'ABCMART') {
      const age = this.latestAt === undefined ? Infinity : now - this.latestAt
      if (age < 0 || age >= ABC_CAPTURE_MAX_AGE_MS || !hasAbcSession(this.latest)) {
        selected = hasAbcSession(jarHeader) ? jarHeader : ''
        source = 'jar'
      }
      if (!selected) return { ...candidate, reason: 'session_cookie_missing_or_capture_stale' }
    } else if (this.site === 'SSG') {
      const parsed = parseCookieHeader(selected)
      if (!parsed.get('FS0') || !parsed.get('FS1')) {
        return { ...candidate, reason: 'ssg_auth_pair_missing' }
      }
    } else if (this.site === 'SNKRDUNK') {
      const session = parseCookieHeader(jarHeader || selected).get('session')
      selected = session ? serialize(new Map([['session', session]])) : ''
      source = jarHeader ? 'jar' : source
    }
    if (!selected) return { ...candidate, reason: 'no_cookie' }
    return {
      ...candidate,
      cookie: selected,
      source,
      ...(source === 'captured' ? { capturedAt: this.latestAt } : {}),
      ...(this.site === 'MUSINSA'
        ? { identity: extractMusinsaIdentity(selected) ?? undefined }
        : {})
    }
  }
}
