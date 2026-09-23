import { parseCm29Identity, SITE_POLICIES, type JajaSite, type SitePolicy } from './policies'

export interface SessionProbeResult {
  state: 'candidate' | 'unknown' | 'expired'
  /** Fixed code only: never contains a URL, response body, cookie or account secret. */
  reason: string
  extra?: { userId: string | number; loginId: string }
}

export type SessionFetcher = (url: string, init: RequestInit) => Promise<Response>

const PROBE_TIMEOUT_MS = 8_000
const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const OFFICIAL_HOSTS: Partial<Record<JajaSite, readonly string[]>> = {
  MUSINSA: ['www.musinsa.com', 'my.musinsa.com', 'member.one.musinsa.com'],
  LOTTEON: ['www.lotteon.com'],
  SSG: ['www.ssg.com', 'my.ssg.com', 'pay.ssg.com', 'member.ssg.com'],
  '29CM': ['user-api.29cm.co.kr', 'auth.29cm.co.kr']
}

const unknown = (reason: string): SessionProbeResult => ({ state: 'unknown', reason })

function safeUrl(raw: string, site: JajaSite): URL | null {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' &&
      !url.port &&
      !url.username &&
      !url.password &&
      OFFICIAL_HOSTS[site]?.includes(url.hostname)
      ? url
      : null
  } catch {
    return null
  }
}

function isLoginPage(site: JajaSite, url: URL): boolean {
  const path = url.pathname.toLowerCase()
  switch (site) {
    case 'MUSINSA':
      return /\/(?:auth\/)?login(?:\/|$)/.test(path)
    case 'LOTTEON':
      return /\/member\/login(?:\/|$)/.test(path) || /\/login(?:\/|$)/.test(path)
    case 'SSG':
      return path.endsWith('/login.ssg') || /\/member\/login(?:\/|$)/.test(path)
    case '29CM':
      return url.hostname === 'auth.29cm.co.kr' && /^\/(?:email-)?login(?:\/|$)/.test(path)
    default:
      return false
  }
}

/**
 * Probe only the audited read-only session endpoints. The supplied fetcher must use the
 * account's Electron Session. Main-process/global fetch does not carry that partition.
 * Redirects are manual because Electron session.fetch can return an empty Response.url.
 * Page-context sites must be checked in their own tab; fetching them here can replace a
 * valid SameSite session with an anonymous session issued by the site.
 */
export async function probeSession(
  policy: SitePolicy,
  fetcher: SessionFetcher
): Promise<SessionProbeResult> {
  const canonical = SITE_POLICIES[policy.site]
  if (!canonical || canonical.kind !== policy.kind) return unknown('unsupported_policy')
  if (canonical.kind === 'page' || canonical.probe?.kind === 'page') {
    return unknown('page_check_required')
  }
  if (!canonical.probe) return unknown('no_probe_available')
  if (canonical.probe.url !== policy.probe?.url || canonical.probe.kind !== policy.probe?.kind) {
    return unknown('unsupported_policy')
  }
  let current = safeUrl(canonical.probe.url, policy.site)
  if (!current) return unknown('unsupported_probe_host')

  const controller = new AbortController()
  const timeoutError = new Error('probe_timeout')
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(timeoutError)
    }, PROBE_TIMEOUT_MS)
  })
  const bounded = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, timeout])

  try {
    const visited = new Set<string>()
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      if (isLoginPage(policy.site, current)) {
        return { state: 'expired', reason: 'login_redirect' }
      }
      if (visited.has(current.href)) return unknown('redirect_loop')
      visited.add(current.href)
      const response = await bounded(
        fetcher(current.href, {
          method: 'GET',
          credentials: 'include',
          redirect: 'manual',
          cache: 'no-store',
          signal: controller.signal,
          headers: {
            Accept: canonical.probe.kind === 'json-identity' ? 'application/json' : 'text/html'
          }
        })
      )

      // Nonempty response URLs are checked as well, in case a transport followed a redirect
      // despite the manual setting. Never classify an external HTML page as logged in.
      if (response.url) {
        const actual = safeUrl(response.url, policy.site)
        if (!actual) return unknown('external_redirect')
        if (isLoginPage(policy.site, actual)) {
          return { state: 'expired', reason: 'login_redirect' }
        }
      }
      if (response.status === 401) return { state: 'expired', reason: 'authentication_required' }
      // A 403 can also be a bot challenge, so it is not proof of an expired session.
      if (response.status === 403) return unknown('access_denied_or_challenge')
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location')
        if (!location) return unknown('redirect_location_missing')
        let next: URL | null
        try {
          next = safeUrl(new URL(location, current).href, policy.site)
        } catch {
          next = null
        }
        if (!next) return unknown('external_redirect')
        if (isLoginPage(policy.site, next)) return { state: 'expired', reason: 'login_redirect' }
        if (redirects === MAX_REDIRECTS) return unknown('redirect_limit')
        current = next
        continue
      }
      if (response.status !== 200) return unknown('unexpected_http_status')
      if (canonical.probe.kind === 'json-identity') {
        const identity = parseCm29Identity(await bounded(response.json()))
        if (!identity) return unknown('identity_unavailable')
        return { state: 'candidate', reason: 'identity_observed', extra: identity }
      }
      return { state: 'candidate', reason: 'protected_page_responded' }
    }
    return unknown('redirect_limit')
  } catch (error) {
    // Never return exception messages: fetch errors can include headers/URLs or page data.
    return unknown(error === timeoutError || controller.signal.aborted ? 'timeout' : 'probe_failed')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
