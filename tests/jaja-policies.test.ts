import { describe, expect, it } from 'vitest'
import {
  CaptureState,
  extractMusinsaIdentity,
  getKreamTokenExpiryMs,
  getSitePolicy,
  isKreamCookieExpired,
  isKreamCookieLoggedOut,
  matchesCaptureUrl,
  needsKreamRefresh,
  normalizeSite,
  parseCm29Identity,
  parseCookieHeader,
  type JarCookie
} from '../src/main/jaja/policies'

// All tokens and cookies in this file are synthetic and unusable against real sites.
const jwt = (payload: Record<string, unknown>): string =>
  `test.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.test`
const jar = (domain: string, name: string, value: string, path = '/'): JarCookie => ({
  domain,
  name,
  value,
  path,
  httpOnly: true,
  secure: true
})

describe('JAJA fixed site policies', () => {
  it.each([
    ['무신사', 'MUSINSA'],
    ['  ABCmart ', 'ABCMART'],
    ['GrandStage', 'ABCMART'],
    ['naver-store', 'NAVER'],
    ['cm29', '29CM']
  ])('normalizes %s without accepting arbitrary websites', (input, expected) => {
    expect(normalizeSite(input)).toBe(expected)
  })

  it('does not claim sites with only extension host permissions are supported', () => {
    expect(getSitePolicy('11st')).toBeNull()
    expect(getSitePolicy('https://example.com')).toBeNull()
  })

  it.each(['GRANDSTAGE', '그랜드스테이지'])(
    'opens %s on its own storefront while retaining the shared cookie capture policy',
    (site) => {
      const grand = getSitePolicy(site)!
      const abc = getSitePolicy('ABCMART')!
      expect(grand).toMatchObject({
        site: 'ABCMART',
        homeUrl: 'https://grandstage.a-rt.com/',
        probe: { url: 'https://grandstage.a-rt.com/mypage', kind: 'page' }
      })
      expect(grand.capturePatterns).toEqual(abc.capturePatterns)
      expect(abc.homeUrl).toBe('https://abcmart.a-rt.com/')
      expect(abc.probe?.url).toBe('https://abcmart.a-rt.com/mypage')
    }
  )

  it('limits Naver capture to shopping and authentication domains', () => {
    expect(matchesCaptureUrl('NAVER', 'https://brand.naver.com/example')).toBe(true)
    expect(matchesCaptureUrl('NAVER', 'https://order.pay.naver.com/order')).toBe(true)
    expect(matchesCaptureUrl('NAVER', 'https://mail.naver.com/')).toBe(false)
    expect(matchesCaptureUrl('NAVER', 'https://blog.naver.com/')).toBe(false)
    expect(matchesCaptureUrl('NAVER', 'https://sell.smartstore.naver.com/')).toBe(false)
  })

  it('rejects lookalike domains, non-HTTPS, unexpected ports and URL credentials', () => {
    for (const url of [
      'https://www.musinsa.com.evil.test/',
      'http://www.musinsa.com/',
      'https://www.musinsa.com:8443/',
      'https://name@www.musinsa.com/',
      'not-a-url'
    ]) {
      expect(matchesCaptureUrl('MUSINSA', url)).toBe(false)
    }
  })

  it('marks page-only sites as forbidden for cookie upload', () => {
    for (const site of ['REXMONDE', 'BUNJANG'] as const) {
      const state = new CaptureState(site)
      expect(state.record(getSitePolicy(site)!.homeUrl, { Cookie: 'session=synthetic' })).toBe(
        false
      )
      expect(state.build()).toMatchObject({ cookie: '', source: 'none', reason: 'page_only' })
      expect(getSitePolicy(site)!.serverSite).toBeNull()
    }
  })

  it('requires 29CM post-verification reread and prohibits automatic relogin', () => {
    expect(getSitePolicy('29CM')).toMatchObject({
      requiresPostProbeRead: true,
      autoRelogin: false,
      probe: {
        url: 'https://user-api.29cm.co.kr/api/v4/users/me',
        kind: 'json-identity'
      }
    })
  })
})

describe('per-account capture state', () => {
  it('unites Musinsa host cookies with www precedence and rejects its SSO host', () => {
    const state = new CaptureState('MUSINSA')
    const token = jwt({ sub: 'synthetic-owner-a' })
    state.record('https://www.musinsa.com/', { Cookie: `mss_mac=${token}; shared=www` }, 100)
    state.record(
      'https://order.musinsa.com/',
      { cookie: `mss_mac=${token}; shared=order; orderOnly=1` },
      101
    )
    expect(
      state.record('https://member.one.musinsa.com/login', { Cookie: 'mss_mac=other' }, 102)
    ).toBe(false)
    expect(parseCookieHeader(state.build().cookie)).toEqual(
      new Map([
        ['mss_mac', token],
        ['shared', 'www'],
        ['orderOnly', '1']
      ])
    )
    expect(state.build().identity).toBe('synthetic-owner-a')
  })

  it('discards all old host captures when the Musinsa token changes', () => {
    const state = new CaptureState('MUSINSA')
    const a = jwt({ sub: 'synthetic-a' })
    const b = jwt({ sub: 'synthetic-b' })
    state.record('https://www.musinsa.com/', { Cookie: `mss_mac=${a}; oldWWW=1` })
    state.record('https://order.musinsa.com/', { Cookie: `mss_mac=${a}; oldOrder=1` })
    state.record('https://www.musinsa.com/', { Cookie: `mss_mac=${b}; newWWW=1` })
    expect(state.build().cookie).not.toContain('old')
    expect(state.build().identity).toBe('synthetic-b')
  })

  it('never shares SSG authentication pairs across account contexts', () => {
    const a = new CaptureState('SSG')
    const b = new CaptureState('SSG')
    a.record('https://pay.ssg.com/', { Cookie: 'FS0=a0; FS1=a1; pay=1' })
    a.record('https://www.ssg.com/', { Cookie: 'page=1' })
    expect(a.build().cookie).toContain('FS0=a0; FS1=a1')
    expect(b.record('https://www.ssg.com/', { Cookie: 'page=1' })).toBe(false)
    expect(b.build().cookie).toBe('')
    a.reset()
    expect(a.record('https://www.ssg.com/', { Cookie: 'page=2' })).toBe(false)
  })

  it('does not offer an SSG cold-start jar without both authentication cookies', () => {
    const state = new CaptureState('SSG')
    expect(state.build([jar('.ssg.com', 'FS0', 'only-one')])).toMatchObject({
      cookie: '',
      reason: 'ssg_auth_pair_missing'
    })
    expect(state.build([jar('.ssg.com', 'FS0', 'a'), jar('.ssg.com', 'FS1', 'b')]).cookie).toBe(
      'FS0=a; FS1=b'
    )
  })

  it('retains HttpOnly jar cookies and excludes unrelated or expired entries', () => {
    const state = new CaptureState('LOTTEON')
    expect(
      state.build(
        [
          jar('.lotteon.com', 'session', 'synthetic'),
          jar('.other.test', 'private', 'excluded'),
          { ...jar('.lotteon.com', 'expired', 'old'), expirationDate: 1 }
        ],
        2000
      ).cookie
    ).toBe('session=synthetic')
  })

  it('accepts Electron maps and extension header arrays without case assumptions', () => {
    const state = new CaptureState('LOTTEON')
    state.record('https://www.lotteon.com/', [{ name: 'cOoKiE', value: 'a=1' }], 100)
    expect(state.build().cookie).toBe('a=1')
    state.record('https://www.lotteon.com/', { COOKIE: ['a=2', 'b=3'] }, 200)
    expect(state.build()).toMatchObject({ cookie: 'a=2; b=3', capturedAt: 200 })
  })

  it('rejects a CRLF header instead of persisting injected headers', () => {
    const state = new CaptureState('LOTTEON')
    expect(state.record('https://www.lotteon.com/', { Cookie: 'a=1\r\nX-Test: bad' })).toBe(false)
    expect(state.build().cookie).toBe('')
  })
})

describe('site-specific candidate selection', () => {
  it('uses the larger 29CM source but still requires actual session verification', () => {
    const state = new CaptureState('29CM')
    state.record('https://www.29cm.co.kr/', { Cookie: 'refresh_token=fake; cap=1; extra=2' })
    const result = state.build([jar('.29cm.co.kr', 'refresh_token', 'also-fake')])
    expect(result).toMatchObject({
      source: 'captured',
      requiresVerification: true,
      requiresPostProbeRead: true
    })
    expect(result.cookie).toContain('extra=2')
  })

  it('prefers the post-probe jar on equal 29CM counts and the longer cookie path', () => {
    const state = new CaptureState('29CM')
    state.record('https://www.29cm.co.kr/', { Cookie: 'refresh_token=before' })
    expect(
      state.build([
        jar('.29cm.co.kr', 'refresh_token', 'root'),
        jar('user-api.29cm.co.kr', 'refresh_token', 'after', '/api')
      ])
    ).toMatchObject({ source: 'jar', cookie: 'refresh_token=after' })
  })

  it('prefers fresh actual ABC request headers and rejects captures at 30 minutes', () => {
    const state = new CaptureState('ABCMART')
    state.record('https://abcmart.a-rt.com/', { Cookie: 'JSESSIONID=observed; analytics=1' }, 100)
    const fallback = [jar('abcmart.a-rt.com', 'JSESSIONID', 'jar-fallback')]
    expect(state.build(fallback, 100 + 29 * 60_000)).toMatchObject({ source: 'captured' })
    expect(state.build(fallback, 100 + 30 * 60_000)).toMatchObject({
      source: 'jar',
      cookie: 'JSESSIONID=jar-fallback'
    })
    expect(state.build([], 100 + 30 * 60_000).cookie).toBe('')
  })

  it('does not replace an ABC session with advertising-only cookies', () => {
    const state = new CaptureState('ABCMART')
    state.record('https://abcmart.a-rt.com/', { Cookie: 'JSESSIONID=observed' }, 100)
    expect(state.record('https://abcmart.a-rt.com/', { Cookie: 'analytics=1' }, 200)).toBe(false)
    expect(state.build([jar('.a-rt.com', 'analytics', '1')], 300).cookie).toBe(
      'JSESSIONID=observed'
    )
  })

  it('refreshes capture age when the same ABC cookie is observed again', () => {
    const state = new CaptureState('ABCMART')
    state.record('https://abcmart.a-rt.com/', { Cookie: 'JSESSIONID=observed' }, 1)
    expect(
      state.record('https://abcmart.a-rt.com/', { Cookie: 'JSESSIONID=observed' }, 1_800_001)
    ).toBe(false)
    expect(state.build([], 1_800_002)).toMatchObject({ source: 'captured', capturedAt: 1_800_001 })
  })

  it('exports only SNKRDUNK session, preferring the current HttpOnly jar', () => {
    const state = new CaptureState('SNKRDUNK')
    state.record('https://snkrdunk.com/', { Cookie: 'session=captured; analytics=1' })
    expect(
      state.build([
        jar('snkrdunk.com', 'session', 'current'),
        jar('snkrdunk.com', 'analytics', '2')
      ])
    ).toMatchObject({ cookie: 'session=current', source: 'jar' })
  })
})

describe('identity and expiry hints', () => {
  it('decodes only Musinsa sub as an owner hint', () => {
    expect(
      extractMusinsaIdentity(`mss_mac=${jwt({ sub: 'synthetic-owner', secret: 'ignored' })}`)
    ).toBe('synthetic-owner')
    expect(extractMusinsaIdentity('mss_mac=malformed')).toBeNull()
    expect(extractMusinsaIdentity(`mss_mac=${jwt({ sub: 123 })}`)).toBeNull()
  })

  it('accepts 29CM identity only from a users/me-shaped response', () => {
    expect(parseCm29Identity({ data: { userId: 42, loginId: 'synthetic' } })).toEqual({
      userId: 42,
      loginId: 'synthetic'
    })
    for (const payload of [
      null,
      {},
      { data: {} },
      { data: { userId: [] } },
      { data: { userId: 0 } }
    ]) {
      expect(parseCm29Identity(payload)).toBeNull()
    }
  })

  it('distinguishes explicit KREAM logout from missing tokens and opaque tokens', () => {
    expect(isKreamCookieLoggedOut('_token.test=false; _token.other=null')).toBe(true)
    expect(isKreamCookieLoggedOut('analytics=1')).toBe(false)
    expect(isKreamCookieExpired('analytics=1')).toBeNull()
    expect(isKreamCookieExpired('_token.test=opaque')).toBeNull()
    expect(isKreamCookieExpired('_token.test=false')).toBe(true)
  })

  it('handles wrapped KREAM JWT expiry and the fifteen-minute refresh window', () => {
    const cookie = `_token.test=${encodeURIComponent(JSON.stringify({ access_token: jwt({ exp: 7200 }) }))}`
    expect(getKreamTokenExpiryMs(cookie)).toBe(7_200_000)
    expect(needsKreamRefresh(cookie, 6_299_999)).toBe(false)
    expect(needsKreamRefresh(cookie, 6_300_000)).toBe(true)
    expect(isKreamCookieExpired(cookie, 7_200_000)).toBe(true)
  })
})
