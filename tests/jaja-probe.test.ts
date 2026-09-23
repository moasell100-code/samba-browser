import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSitePolicy, type SitePolicy } from '../src/main/jaja/policies'
import { probeSession, type SessionFetcher } from '../src/main/jaja/probe'

const policy = (site: string): SitePolicy => getSitePolicy(site)!
const response = (status = 200, headers?: Record<string, string>, body = ''): Response =>
  new Response(body, { status, headers })

afterEach(() => vi.useRealTimers())

describe('partition session probes without real network calls', () => {
  it('uses manual Location redirects when Response.url is empty', async () => {
    const fetcher = vi
      .fn<SessionFetcher>()
      .mockResolvedValueOnce(response(302, { Location: '/mypage/after-redirect' }))
      .mockResolvedValueOnce(response())
    expect(await probeSession(policy('MUSINSA'), fetcher)).toEqual({
      state: 'candidate',
      reason: 'protected_page_responded'
    })
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://www.musinsa.com/mypage/after-redirect',
      expect.objectContaining({ method: 'GET', credentials: 'include', redirect: 'manual' })
    )
  })

  it.each([
    ['MUSINSA', 'https://member.one.musinsa.com/login'],
    ['SSG', 'https://member.ssg.com/member/login.ssg'],
    ['LOTTEON', '/p/member/login/common']
  ])(
    'recognizes the official %s login redirect without requesting the login page',
    async (site, location) => {
      const fetcher = vi
        .fn<SessionFetcher>()
        .mockResolvedValue(response(302, { Location: location }))
      expect(await probeSession(policy(site), fetcher)).toEqual({
        state: 'expired',
        reason: 'login_redirect'
      })
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    'https://outside.example/private',
    'https://www.musinsa.com.outside.example/private',
    'http://www.musinsa.com/private',
    'https://name@www.musinsa.com/private',
    'https://www.musinsa.com:8443/private'
  ])('never follows an unapproved redirect to %s', async (location) => {
    const fetcher = vi.fn<SessionFetcher>().mockResolvedValue(response(302, { Location: location }))
    expect(await probeSession(policy('MUSINSA'), fetcher)).toEqual({
      state: 'unknown',
      reason: 'external_redirect'
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('checks a nonempty URL returned by a transport that followed a redirect', async () => {
    const result = response()
    Object.defineProperty(result, 'url', { value: 'https://outside.example/private' })
    const fetcher = vi.fn<SessionFetcher>().mockResolvedValue(result)
    expect(await probeSession(policy('MUSINSA'), fetcher)).toEqual({
      state: 'unknown',
      reason: 'external_redirect'
    })
  })

  it('does not treat a login URL returned by the transport as authenticated', async () => {
    const result = response()
    Object.defineProperty(result, 'url', { value: 'https://www.musinsa.com/auth/login' })
    const fetcher = vi.fn<SessionFetcher>().mockResolvedValue(result)
    expect(await probeSession(policy('MUSINSA'), fetcher)).toEqual({
      state: 'expired',
      reason: 'login_redirect'
    })
  })

  it('stops a redirect loop', async () => {
    const fetcher = vi
      .fn<SessionFetcher>()
      .mockResolvedValue(response(302, { Location: '/mypage/myreview' }))
    expect(await probeSession(policy('MUSINSA'), fetcher)).toEqual({
      state: 'unknown',
      reason: 'redirect_loop'
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('follows at most five redirects', async () => {
    let count = 0
    const fetcher = vi
      .fn<SessionFetcher>()
      .mockImplementation(async () => response(302, { Location: `/hop-${++count}` }))
    expect(await probeSession(policy('MUSINSA'), fetcher)).toEqual({
      state: 'unknown',
      reason: 'redirect_limit'
    })
    expect(fetcher).toHaveBeenCalledTimes(6)
  })

  it('requires Location when a redirect status has no response URL', async () => {
    const fetcher = vi.fn<SessionFetcher>().mockResolvedValue(response(302))
    expect(await probeSession(policy('SSG'), fetcher)).toEqual({
      state: 'unknown',
      reason: 'redirect_location_missing'
    })
  })

  it.each(['ABCMART', 'KREAM', 'REXMONDE', 'BUNJANG'])(
    'does not fetch page-context site %s',
    async (site) => {
      const fetcher = vi.fn<SessionFetcher>()
      expect(await probeSession(policy(site), fetcher)).toEqual({
        state: 'unknown',
        reason: 'page_check_required'
      })
      expect(fetcher).not.toHaveBeenCalled()
    }
  )

  it.each(['NAVER', 'SNKRDUNK'])('does not invent a probe URL for %s', async (site) => {
    const fetcher = vi.fn<SessionFetcher>()
    expect(await probeSession(policy(site), fetcher)).toEqual({
      state: 'unknown',
      reason: 'no_probe_available'
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects an injected URL even on an official host', async () => {
    const fetcher = vi.fn<SessionFetcher>()
    const altered: SitePolicy = {
      ...policy('MUSINSA'),
      probe: { kind: 'redirect', url: 'https://www.musinsa.com/auth/logout' }
    }
    expect(await probeSession(altered, fetcher)).toEqual({
      state: 'unknown',
      reason: 'unsupported_policy'
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('returns a 29CM identity hint for post-probe cookie collection', async () => {
    const fetcher = vi
      .fn<SessionFetcher>()
      .mockResolvedValue(
        response(
          200,
          { 'Content-Type': 'application/json' },
          JSON.stringify({ data: { userId: 42, loginId: 'synthetic' } })
        )
      )
    expect(await probeSession(policy('29CM'), fetcher)).toEqual({
      state: 'candidate',
      reason: 'identity_observed',
      extra: { userId: 42, loginId: 'synthetic' }
    })
    expect(fetcher).toHaveBeenCalledWith(
      'https://user-api.29cm.co.kr/api/v4/users/me',
      expect.objectContaining({ credentials: 'include', redirect: 'manual', cache: 'no-store' })
    )
  })

  it.each([401, 403, 429, 500])(
    'distinguishes status %s from a verified usable session',
    async (status) => {
      const fetcher = vi.fn<SessionFetcher>().mockResolvedValue(response(status))
      expect((await probeSession(policy('29CM'), fetcher)).state).toBe(
        status === 401 ? 'expired' : 'unknown'
      )
    }
  )

  it('does not accept an anonymous JSON response or successful non-JSON challenge', async () => {
    const missing = vi.fn<SessionFetcher>().mockResolvedValue(response(200, {}, '{"data":{}}'))
    const challenge = vi
      .fn<SessionFetcher>()
      .mockResolvedValue(response(200, {}, '<html>challenge</html>'))
    expect(await probeSession(policy('29CM'), missing)).toEqual({
      state: 'unknown',
      reason: 'identity_unavailable'
    })
    expect(await probeSession(policy('29CM'), challenge)).toEqual({
      state: 'unknown',
      reason: 'probe_failed'
    })
  })

  it('times out and aborts even when the transport ignores the abort signal', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<SessionFetcher>().mockImplementation(() => new Promise(() => {}))
    const pending = probeSession(policy('SSG'), fetcher)
    await vi.advanceTimersByTimeAsync(8_000)
    expect(await pending).toEqual({ state: 'unknown', reason: 'timeout' })
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true)
  })

  it('uses one deadline for the full redirect chain', async () => {
    vi.useFakeTimers()
    let count = 0
    const fetcher = vi
      .fn<SessionFetcher>()
      .mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(response(302, { Location: `/slow-${++count}` })), 3_000)
          )
      )
    const pending = probeSession(policy('SSG'), fetcher)
    await vi.advanceTimersByTimeAsync(8_000)
    expect(await pending).toEqual({ state: 'unknown', reason: 'timeout' })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('bounds reading a hanging JSON response body', async () => {
    vi.useFakeTimers()
    const hanging = response()
    hanging.json = () => new Promise(() => {})
    const fetcher = vi.fn<SessionFetcher>().mockResolvedValue(hanging)
    const pending = probeSession(policy('29CM'), fetcher)
    await vi.advanceTimersByTimeAsync(8_000)
    expect(await pending).toEqual({ state: 'unknown', reason: 'timeout' })
  })

  it('does not leak the transport exception message', async () => {
    const fetcher = vi
      .fn<SessionFetcher>()
      .mockRejectedValue(new Error('private cookie=synthetic URL=/secret'))
    expect(await probeSession(policy('SSG'), fetcher)).toEqual({
      state: 'unknown',
      reason: 'probe_failed'
    })
  })
})
