import type { BeforeSendResponse, OnBeforeSendHeadersListenerDetails, Session } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  observeSessionRequests,
  transformSessionRequestHeaders
} from '../src/main/browser/request-hooks'
import { installWebstoreUserAgent } from '../src/main/browser/webstore-ua'

function fakeSession(): {
  session: Session
  install: ReturnType<typeof vi.fn>
  request: (url: string, headers?: Record<string, string>) => BeforeSendResponse
} {
  let listener:
    | ((d: OnBeforeSendHeadersListenerDetails, cb: (response: BeforeSendResponse) => void) => void)
    | undefined
  const install = vi.fn((next: typeof listener) => {
    listener = next
  })
  return {
    session: {
      getUserAgent: () =>
        'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) samba/1.0 Chrome/142.0 Electron/39.0 Safari/537.36',
      webRequest: { onBeforeSendHeaders: install }
    } as unknown as Session,
    install,
    request: (url, requestHeaders = { Cookie: 'test-session=opaque' }) => {
      const callback = vi.fn()
      listener?.(
        {
          id: 1,
          url,
          method: 'GET',
          resourceType: 'xhr',
          referrer: '',
          timestamp: 1,
          requestHeaders
        },
        callback
      )
      expect(callback).toHaveBeenCalledTimes(1)
      return callback.mock.calls[0][0]
    }
  }
}

describe('session request dispatcher', () => {
  it.each(['observer-first', 'ua-first'])(
    '%s: UA 와 쿠키 관측은 한 리스너에서 함께 동작한다',
    (order) => {
      const fake = fakeSession()
      const observe = vi.fn()
      if (order === 'observer-first') observeSessionRequests(fake.session, 'jaja', observe)
      installWebstoreUserAgent(fake.session)
      if (order === 'ua-first') observeSessionRequests(fake.session, 'jaja', observe)
      const response = fake.request('https://chromewebstore.google.com/detail/test', {
        Cookie: 'test-session=opaque',
        'user-agent': 'old'
      })
      expect(fake.install).toHaveBeenCalledTimes(1)
      expect(response.requestHeaders?.['User-Agent']).not.toContain('Electron')
      expect(response.requestHeaders?.['user-agent']).toBeUndefined()
      expect(observe).toHaveBeenCalledWith(
        expect.objectContaining({ requestHeaders: response.requestHeaders })
      )
      const normal = fake.request('https://shop.example/cart', {
        Cookie: 'account=A',
        'User-Agent': 'mobile'
      })
      expect(normal.requestHeaders).toEqual({ Cookie: 'account=A', 'User-Agent': 'mobile' })
      expect(observe).toHaveBeenCalledTimes(2)
    }
  )

  it('세션은 서로 격리하고 오래된 dispose 는 같은 key 의 새 관측자를 지우지 않는다', () => {
    const a = fakeSession()
    const b = fakeSession()
    const old = vi.fn()
    const current = vi.fn()
    const other = vi.fn()
    const disposeOld = observeSessionRequests(a.session, 'jaja', old)
    const disposeCurrent = observeSessionRequests(a.session, 'jaja', current)
    observeSessionRequests(b.session, 'jaja', other)
    disposeOld()
    a.request('https://shop.example/')
    expect(old).not.toHaveBeenCalled()
    expect(current).toHaveBeenCalledTimes(1)
    expect(other).not.toHaveBeenCalled()
    disposeCurrent()
    disposeCurrent()
    a.request('https://shop.example/')
    b.request('https://shop.example/')
    expect(current).toHaveBeenCalledTimes(1)
    expect(other).toHaveBeenCalledTimes(1)
    expect(a.install).toHaveBeenCalledTimes(1)
  })

  it('관측자가 헤더를 바꾸거나 실패해도 요청과 다른 관측자를 보존한다', async () => {
    const fake = fakeSession()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      transformSessionRequestHeaders(fake.session, 'broken-transform', () => {
        throw new Error('test-secret-must-not-be-logged')
      })
      observeSessionRequests(fake.session, 'mutation', (details) => {
        ;(details.requestHeaders as Record<string, string>).Cookie = 'wrong-account'
      })
      observeSessionRequests(fake.session, 'async-failure', async () => {
        throw new Error('test-secret-must-not-be-logged')
      })
      const good = vi.fn()
      observeSessionRequests(fake.session, 'good', good)
      expect(fake.request('https://shop.example/').requestHeaders?.Cookie).toBe(
        'test-session=opaque'
      )
      expect(good).toHaveBeenCalledTimes(1)
      await Promise.resolve()
      expect(warn.mock.calls.flat().join(' ')).not.toContain('test-secret')
    } finally {
      warn.mockRestore()
    }
  })

  it('관측자 해제 뒤에도 UA 변환은 유지한다', () => {
    const fake = fakeSession()
    const observe = vi.fn()
    installWebstoreUserAgent(fake.session)
    const dispose = observeSessionRequests(fake.session, 'jaja', observe)
    dispose()
    const response = fake.request('https://chromewebstore.google.com/detail/test')
    expect(response.requestHeaders?.['User-Agent']).toContain('Chrome/')
    expect(observe).not.toHaveBeenCalled()
    expect(fake.install).toHaveBeenCalledTimes(1)
  })
})
