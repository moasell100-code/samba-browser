import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FinanceCardIssuer } from '../src/shared/finance-capture'
vi.mock('../src/main/browser/emulation', () => ({ ensureDebuggerAttached: vi.fn(() => true) }))
import { ensureDebuggerAttached } from '../src/main/browser/emulation'
import { CardNetworkObserver, CARD_NETWORK_LIMITS } from '../src/main/finance/card-network-observer'

const HISTORY = 'https://www.hyundaicard.com/cpa/cb/CPACB0101_01.hc'
const ENDPOINT = 'https://www.hyundaicard.com/cpa/cb/CPACB0101_02.hc'
const observers: CardNetworkObserver[] = []
// Synthetic events only. No actual browser, credentials, network or user files.
function fixture(
  issuer: FinanceCardIssuer = 'hyundai_card',
  initialUrl = HISTORY
): {
  observer: CardNetworkObserver
  events: EventEmitter
  wcEvents: EventEmitter
  send: ReturnType<typeof vi.fn>
  setUrl: (url: string) => void
  setBody: (body: string, base64?: boolean) => void
  request: (
    id?: string,
    changes?: Record<string, unknown>,
    requestChanges?: Record<string, unknown>
  ) => void
  response: (id?: string, changes?: Record<string, unknown>) => void
  finish: (id?: string, length?: number) => Promise<void>
} {
  let url = initialUrl
  let body = JSON.stringify({
    data: {
      list: [{ name: 'private-name', amount: 123456789, approval: 'private-id' }],
      totalCnt: '1'
    }
  })
  let base64Encoded = false
  const events = new EventEmitter()
  const wcEvents = new EventEmitter()
  const send = vi.fn(async (method: string) =>
    method === 'Network.getResponseBody' ? { body, base64Encoded } : {}
  )
  const wc = Object.assign(wcEvents, {
    debugger: Object.assign(events, { sendCommand: send }),
    getURL: () => url,
    isDestroyed: () => false
  }) as unknown as WebContents
  const observer = new CardNetworkObserver(wc, issuer)
  observers.push(observer)
  const request = (id = 'opaque-private-request-id', changes = {}, requestChanges = {}): void => {
    events.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: id,
      type: 'XHR',
      documentURL: url,
      request: {
        url: ENDPOINT,
        method: 'POST',
        postData: 'startDate=private-date&endDate=private-date&pageNo=9&token=private-token',
        ...requestChanges
      },
      ...changes
    })
  }
  const response = (id = 'opaque-private-request-id', changes = {}): void => {
    events.emit('message', {}, 'Network.responseReceived', {
      requestId: id,
      response: { url: ENDPOINT, status: 200, mimeType: 'application/json', ...changes }
    })
  }
  const finish = async (id = 'opaque-private-request-id', length = 200): Promise<void> => {
    events.emit('message', {}, 'Network.loadingFinished', {
      requestId: id,
      encodedDataLength: length
    })
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
  return {
    observer,
    events,
    wcEvents,
    send,
    setUrl: (value) => {
      url = value
    },
    setBody: (value, base64 = false) => {
      body = value
      base64Encoded = base64
    },
    request,
    response,
    finish
  }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(ensureDebuggerAttached).mockReturnValue(true)
})
afterEach(() => {
  for (const observer of observers.splice(0)) observer.dispose()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('temporary card read-only network observation', () => {
  it('attaches before navigation and returns only field names, array counts and known totals', async () => {
    const f = fixture('hyundai_card', 'about:blank')
    await f.observer.start()
    f.request()
    expect(f.observer.snapshot().records).toEqual([])
    f.setUrl(HISTORY)
    f.request(
      undefined,
      {},
      {
        url: `${ENDPOINT}?startDt=private-date&cardNo=private-card&access_token=private-token`,
        postData: JSON.stringify({
          pageNo: 4,
          endDate: 'private-date',
          password: 'private-password',
          data: { secret: 'private-secret' }
        })
      }
    )
    f.response()
    await f.finish()
    const snapshot = f.observer.snapshot()
    expect(snapshot.records[0]).toEqual({
      origin: 'https://www.hyundaicard.com',
      path: '/cpa/cb/CPACB0101_02.hc',
      pathRedacted: false,
      method: 'POST',
      queryFields: ['cardNo', 'startDt'],
      bodyFields: ['data', 'endDate', 'pageNo'],
      fieldsTruncated: false,
      status: 200,
      response: {
        kind: 'json',
        arrays: [{ path: '$.data.list', count: 1 }],
        totals: [{ path: '$.data.totalCnt', count: 1 }],
        truncated: false
      }
    })
    expect(JSON.stringify(snapshot)).not.toMatch(/private|123456789|opaque|password|token/)
    expect(f.send.mock.calls.map(([method]) => method)).toEqual([
      'Network.enable',
      'Network.getResponseBody'
    ])
  })

  it.each([
    'http://www.hyundaicard.com/cpa/cb/CPACB0101_02.hc',
    'https://www.hyundaicard.com:8443/cpa/cb/CPACB0101_02.hc',
    'https://user:pass@www.hyundaicard.com/cpa/cb/CPACB0101_02.hc',
    'https://www.hyundaicard.com.evil.test/history',
    'https://www.samsungcard.com/history',
    'https://www.hyundaicard.com/login',
    'https://www.hyundaicard.com/api/transfer',
    'https://www.hyundaicard.com/cpm/mb/CPMMB0101_02.hc'
  ])('ignores off-origin and authentication/write routes: %s', async (url) => {
    const f = fixture()
    await f.observer.start()
    f.request(undefined, {}, { url })
    f.response(undefined, { url })
    await f.finish()
    expect(f.observer.snapshot().records).toEqual([])
    expect(f.send).toHaveBeenCalledOnce()
  })

  it('requires the exact history document and XHR/Fetch, not frames or other resource types', async () => {
    const f = fixture()
    await f.observer.start()
    f.request('wrong-document', { documentURL: 'https://www.hyundaicard.com/index.jsp' })
    f.request('script', { type: 'Script' })
    f.events.emit(
      'message',
      {},
      'Network.requestWillBeSent',
      {
        requestId: 'child',
        type: 'XHR',
        documentURL: HISTORY,
        request: { url: ENDPOINT, method: 'GET' }
      },
      'child-session'
    )
    f.setUrl('https://www.hyundaicard.com/login')
    f.request()
    expect(f.observer.snapshot().records).toEqual([])
  })

  it.each([
    [
      'samsung_card',
      'https://www.samsungcard.com/personal/card/activity/UHPPRP0801M0.jsp',
      'https://www.samsungcard.com/personal/card/activity/UHPPRP0801D0.jsp'
    ],
    [
      'lotte_card',
      'https://www.lottecard.co.kr/app/LPMCDAA_V100.lc',
      'https://www.lottecard.co.kr/app/LPMCDAA_V101.lc'
    ]
  ] as const)(
    'supports only each issuer own history scope: %s',
    async (issuer, history, endpoint) => {
      const f = fixture(issuer, history)
      await f.observer.start()
      f.request(undefined, { type: 'Fetch' }, { url: endpoint })
      f.response(undefined, { url: endpoint })
      await f.finish()
      expect(f.observer.snapshot().records[0].response?.kind).toBe('json')
    }
  )

  it('does not read header/cookie properties or request-body values into results', async () => {
    const f = fixture()
    await f.observer.start()
    const request = {
      url: ENDPOINT,
      method: 'POST',
      postData: 'page=1&card=private',
      get headers(): never {
        throw new Error('private-header')
      }
    }
    f.events.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'id',
      type: 'XHR',
      documentURL: HISTORY,
      request
    })
    f.events.emit('message', {}, 'Network.responseReceived', {
      requestId: 'id',
      response: {
        url: ENDPOINT,
        status: 200,
        mimeType: 'application/json',
        get headers(): never {
          throw new Error('private-cookie')
        }
      }
    })
    await f.finish('id')
    expect(f.observer.snapshot().records[0].response?.kind).toBe('json')
    expect(JSON.stringify(f.observer.snapshot())).not.toMatch(/private|headers|cookie/)
  })

  it('preserves the official Samsung service route and bounded nested parameter names only', async () => {
    const f = fixture(
      'samsung_card',
      'https://www.samsungcard.com/personal/card/activity/UHPPRP0801M0.jsp'
    )
    await f.observer.start()
    const endpoint = 'https://www.samsungcard.com/frontservice/SHPPRP0801S51'
    f.request(
      undefined,
      {},
      {
        url: endpoint,
        postData: JSON.stringify({
          common: { pageNo: 2, token: 'private-token' },
          body: {
            period: { startDate: 'private-start', endDate: 'private-end' },
            rows: [{ privateName: 'private-name' }]
          },
          deep: { two: { three: { privateTooDeep: 'private-value' } } }
        })
      }
    )
    f.setBody(JSON.stringify({ body: { totdlngct: 180, list: [{ privateValue: 'private' }] } }))
    f.response(undefined, { url: endpoint })
    await f.finish()
    const record = f.observer.snapshot().records[0]
    expect(record.path).toBe('/frontservice/SHPPRP0801S51')
    expect(record.pathRedacted).toBe(false)
    expect(record.bodyFields).toEqual([
      'body',
      'body.period',
      'body.period.endDate',
      'body.period.startDate',
      'body.rows',
      'common',
      'common.pageNo',
      'deep',
      'deep.two',
      'deep.two.three'
    ])
    expect(record.fieldsTruncated).toBe(true)
    expect(record.response?.totals).toEqual([{ path: '$.body.totdlngct', count: 180 }])
    expect(JSON.stringify(record)).not.toMatch(/private|token/)
  })

  it('redacts dynamic path segments and verifies original response paths before reading bodies', async () => {
    const f = fixture()
    await f.observer.start()
    f.request(
      undefined,
      {},
      { url: 'https://www.hyundaicard.com/api/history/customer-private-12345678' }
    )
    f.response(undefined, {
      url: 'https://www.hyundaicard.com/api/history/different-private-87654321'
    })
    await f.finish()
    expect(f.observer.snapshot().records[0]).toMatchObject({
      path: '/api/history/[redacted]',
      pathRedacted: true
    })
    expect(f.send).toHaveBeenCalledOnce()
    expect(JSON.stringify(f.observer.snapshot())).not.toMatch(/customer|12345678|87654321/)
  })

  it('never traverses transaction rows and does not treat totals of money as record counts', async () => {
    const f = fixture()
    await f.observer.start()
    f.setBody(
      JSON.stringify({
        data: {
          rows: [{ totalCount: 12345, nested: ['private'], card: 'private' }],
          totalAmount: 99887766,
          balance: 112233,
          totalCnt: 1
        },
        'user-123456789': ['private'],
        access_token: ['private']
      })
    )
    f.request()
    f.response()
    await f.finish()
    expect(f.observer.snapshot().records[0].response).toEqual({
      kind: 'json',
      arrays: [{ path: '$.data.rows', count: 1 }],
      totals: [{ path: '$.data.totalCnt', count: 1 }],
      truncated: false
    })
    expect(JSON.stringify(f.observer.snapshot())).not.toMatch(/private|12345|99887766|112233|token/)
  })

  it('does not fetch HTML or failed responses, and caps encoded and decoded body sizes', async () => {
    const f = fixture()
    await f.observer.start()
    f.request('html')
    f.response('html', { mimeType: 'text/html' })
    await f.finish('html')
    f.request('failed')
    f.response('failed', { status: 401 })
    await f.finish('failed')
    f.request('large')
    f.response('large')
    await f.finish('large', CARD_NETWORK_LIMITS.bodyBytes + 1)
    expect(f.send).toHaveBeenCalledOnce()
    f.setBody(JSON.stringify({ rows: ['한'.repeat(CARD_NETWORK_LIMITS.bodyBytes / 2)] }))
    f.request('decoded')
    f.response('decoded')
    await f.finish('decoded', 100)
    expect(f.observer.snapshot().records.map(({ response }) => response?.kind)).toEqual([
      'non_json',
      'unavailable',
      'too_large',
      'too_large'
    ])
  })

  it('bounds records, field names and response traversal while preserving only summary counts', async () => {
    const f = fixture()
    await f.observer.start()
    f.setBody(
      JSON.stringify(
        Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`rows${index}`, []]))
      )
    )
    f.request('first', {}, { postData: 'x'.repeat(CARD_NETWORK_LIMITS.requestBytes + 1) })
    f.response('first')
    await f.finish('first')
    for (let i = 0; i < 60; i++) f.request(`request-${i}`)
    const snapshot = f.observer.snapshot()
    expect(snapshot.records).toHaveLength(CARD_NETWORK_LIMITS.requests)
    expect(snapshot.limitReached).toBe(true)
    expect(snapshot.records[0].fieldsTruncated).toBe(true)
    expect(snapshot.records[0].response?.arrays).toHaveLength(CARD_NETWORK_LIMITS.shapeArrays)
    expect(snapshot.records[0].response?.truncated).toBe(true)
  })

  it('times out safely and leaves other debugger listeners and Network enabled on disposal', async () => {
    const f = fixture()
    const unrelated = vi.fn()
    f.events.on('message', unrelated)
    await f.observer.start()
    f.send.mockImplementation(async () => new Promise(() => {}))
    f.request()
    f.response()
    void f.finish()
    await vi.advanceTimersByTimeAsync(CARD_NETWORK_LIMITS.bodyTimeoutMs)
    expect(f.observer.snapshot().records[0].response?.kind).toBe('unavailable')
    await vi.advanceTimersByTimeAsync(CARD_NETWORK_LIMITS.durationMs)
    expect(f.observer.snapshot().state).toBe('stopped')
    expect(f.events.listeners('message')).toEqual([unrelated])
    expect(f.events.listenerCount('detach')).toBe(0)
    expect(f.wcEvents.listenerCount('destroyed')).toBe(0)
    expect(f.send.mock.calls.map(([method]) => method)).not.toContain('Network.disable')
  })

  it('discards late response bodies after destruction and returns fixed failure states', async () => {
    const f = fixture()
    await f.observer.start()
    let resolve: (value: unknown) => void = () => {}
    f.send.mockImplementation(
      async () =>
        new Promise((done) => {
          resolve = done
        })
    )
    f.request()
    f.response()
    void f.finish()
    f.wcEvents.emit('destroyed')
    resolve({ body: '{"rows":["private-late"]}', base64Encoded: false })
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(f.observer.snapshot().state).toBe('stopped')
    expect(f.observer.snapshot().records[0].response).toBeUndefined()
    const unavailable = fixture()
    vi.mocked(ensureDebuggerAttached).mockReturnValue(false)
    await unavailable.observer.start()
    expect(unavailable.observer.snapshot().state).toBe('unavailable')
    expect(unavailable.send).not.toHaveBeenCalled()
  })
})
