import { webcrypto } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../src/main/browser/tab-manager'
import { pageBridge } from '../src/main/browser/page-bridge'
import { probeSamsungCancelDate } from '../src/main/finance/samsung-cancel-date-diagnostic'

const URL = 'https://www.samsungcard.com/personal/card/activity/UHPPRP0801M0.jsp'
const RANGE = { from: '2026-08-01', to: '2026-08-04' }
const windows: JSDOM[] = []
type Query = {
  service: string
  data: Record<string, unknown>
  success(value: unknown): void
  error(value?: unknown): void
}
function row(index = 1): Record<string, unknown> {
  return {
    slDt: '20260701',
    slRcpdt: '20260803',
    slMngtNo: `PRIVATE_SALE_ID_${index}`,
    procsCt: 1,
    canProcsRsC: '2',
    aprno: '12345678',
    itgCdnoe: '0000000000004321',
    mrcNm: 'PRIVATE_MERCHANT',
    slAm: 918273,
    token: 'PRIVATE_TOKEN'
  }
}
function detail(index = 1): Record<string, unknown> {
  return {
    slMngtNo: `PRIVATE_SALE_ID_${index}`,
    slRcpdt: '20260803',
    canPrcsdt: '20260805',
    poCanProcsRsC: '2',
    canProcsAm: 918273,
    acnoe: 'PRIVATE_ACCOUNT'
  }
}
function response(
  rows: object[] = [],
  details: object[] = [],
  total = rows.length,
  cursor = ''
): object {
  return {
    common: { procsRsDvC: '0' },
    totDlngCt: String(total),
    hppRPStlmCanIzSub01SVO: rows,
    hppRPStlmCanIzSub02SVO: details,
    no1NextKeyCn: cursor,
    no2NextKeyCn: cursor ? cursor + '_SECOND' : '',
    token: 'PRIVATE_RESPONSE_TOKEN'
  }
}
function fixture(handler?: (query: Query) => void): {
  tab: Tab
  wc: EventEmitter & {
    getURL: () => string
    isDestroyed: () => boolean
    executeJavaScript: ReturnType<typeof vi.fn>
  }
  dom: JSDOM
  calls: Query[]
  execute: ReturnType<typeof vi.fn>
  condition: Record<string, string | number>
  auth: ReturnType<typeof vi.spyOn<typeof pageBridge, 'cardSession'>>
  setUrl: (next: string) => void
  destroy: () => void
} {
  let url = URL
  let destroyed = false
  const dom = new JSDOM('<input id="start_day" value="2026.01.01">', {
    url,
    runScripts: 'outside-only'
  })
  windows.push(dom)
  Object.defineProperty(dom.window.crypto, 'subtle', { value: webcrypto.subtle })
  Object.assign(dom.window, { TextEncoder })
  const condition = {
    cardDvC: '1',
    cardKndC: '01',
    isCstMngtNo: 'PRIVATE_CUSTOMER',
    pssCstMngtNo: 0,
    cardCntrNo: 0,
    inqrStrtdt: '20260101',
    selCd: '2',
    unrequested: 'PRIVATE_FORM_SECRET'
  }
  const calls: Query[] = []
  Object.assign(dom.window, {
    ENV: { CONDITION: condition },
    scard: {
      ajax: (query: Query) => {
        calls.push(query)
        if (handler) handler(query)
        else query.success(response())
      }
    }
  })
  const execute = vi.fn((script: string, gesture: boolean) => {
    expect(gesture).toBe(false)
    return dom.window.eval(script)
  })
  const wc = Object.assign(new EventEmitter(), {
    getURL: () => url,
    isDestroyed: () => destroyed,
    executeJavaScript: execute
  })
  const tab = { view: { webContents: wc } } as unknown as Tab
  const auth = vi
    .spyOn(pageBridge, 'cardSession')
    .mockResolvedValue({ issuer: 'samsung_card', state: 'signed_in' })
  return {
    tab,
    wc,
    dom,
    calls,
    execute,
    condition,
    auth,
    setUrl: (next: string) => {
      url = next
    },
    destroy: () => {
      destroyed = true
      wc.emit('destroyed')
    }
  }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const dom of windows.splice(0)) dom.window.close()
})

describe('Samsung S43 date-only diagnostic', () => {
  it('returns partial when totals match but a terminal cursor remains', async () => {
    const f = fixture((query) =>
      query.success(
        query.data.slOcDvC === '1'
          ? response([row()], [detail()], 1, 'PRIVATE_TERMINAL_CURSOR')
          : response()
      )
    )
    const result = await probeSamsungCancelDate(f.tab, RANGE)
    expect(result).toMatchObject({
      state: 'partial',
      scopes: [
        { issue: 'terminal_cursor_remaining', termination: 'stopped', statistics: { rows: 1 } },
        { termination: 'count_exhausted' }
      ]
    })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
  })
  it('stops duplicate official join keys across pages even with changing cursors and matching reported totals', async () => {
    const f = fixture((query) =>
      query.success(
        query.data.slOcDvC === '1'
          ? response(
              Array.from({ length: 10 }, (_, i) => row(i)),
              [],
              20,
              query.data.pgeNo ? '' : 'PRIVATE_FIRST_CURSOR'
            )
          : response()
      )
    )
    const result = await probeSamsungCancelDate(f.tab, RANGE)
    expect(result).toMatchObject({
      state: 'partial',
      scopes: [
        { pages: 2, issue: 'duplicate_rows', duplicateRows: 10, statistics: { rows: 10 } },
        { termination: 'count_exhausted' }
      ]
    })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
  })
  it('never awaits digest or starts new ajax after an aborted pending session returns', async () => {
    let releaseDigest!: (value: ArrayBuffer) => void
    const digestWait = new Promise<ArrayBuffer>((resolve) => {
      releaseDigest = resolve
    })
    const digest = vi.spyOn(webcrypto.subtle, 'digest').mockImplementation(() => digestWait)
    const f = fixture()
    let releaseAuth!: (value: { issuer: 'samsung_card'; state: 'signed_in' }) => void
    f.auth.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseAuth = resolve
        })
    )
    const abort = new AbortController()
    const pending = probeSamsungCancelDate(f.tab, RANGE, abort.signal)
    await vi.waitFor(() => expect(f.auth).toHaveBeenCalled())
    abort.abort()
    expect((await pending).issue).toBe('aborted')
    releaseAuth({ issuer: 'samsung_card', state: 'signed_in' })
    releaseDigest(new ArrayBuffer(32))
    await new Promise((resolve) => setImmediate(resolve))
    expect(digest).not.toHaveBeenCalled()
    expect(f.calls).toHaveLength(0)
  })
  it.each(['M0', 'D0', 'D8'])(
    'uses the public parent ENV scope on the supported %s history context, ignoring stale ENV08 conditions',
    async (page) => {
      const f = fixture()
      const url = URL.replace('0801M0', `0801${page}`)
      f.dom.reconfigure({ url })
      f.setUrl(url)
      Object.assign(f.dom.window, {
        ENV08: {
          CONDITION: {
            inqrDvC: '2',
            isCstMngtNo: 'PRIVATE_STALE_CUSTOMER',
            cardCntrNo: 'PRIVATE_SINGLE_CARD'
          }
        }
      })
      const result = await probeSamsungCancelDate(f.tab, RANGE)
      expect(result.state).toBe('ready')
      expect(
        f.calls.every(
          (query) =>
            query.data.isCstMngtNo === 'PRIVATE_CUSTOMER' &&
            query.data.cardCntrNo === 0 &&
            query.data.inqrDvC === '0'
        )
      ).toBe(true)
      expect(JSON.stringify(result)).not.toContain('PRIVATE')
    }
  )
  it('does not substitute a detailed-view ENV08 for a missing public parent scope', async () => {
    const f = fixture()
    Object.assign(f.dom.window, {
      ENV: undefined,
      ENV08: { CONDITION: { ...f.condition, inqrDvC: '0' } }
    })
    const result = await probeSamsungCancelDate(f.tab, RANGE)
    expect(result.scopes.every((scope) => scope.issue === 'page_not_ready')).toBe(true)
    expect(f.calls).toHaveLength(0)
  })
  it('bounds a stalled S43 request without retrying it and may inspect the independent second scope', async () => {
    vi.useFakeTimers()
    const f = fixture((query) => {
      if (query.data.slOcDvC === '2') query.success(response())
    })
    const pending = probeSamsungCancelDate(f.tab, RANGE)
    await vi.waitFor(() => expect(f.calls).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(15000)
    const result = await pending
    expect(result.scopes[0]).toMatchObject({
      termination: 'stopped',
      issue: 'request_timeout',
      pages: 1
    })
    expect(result.scopes[1].termination).toBe('count_exhausted')
    expect(f.calls).toHaveLength(2)
  })
  it('queries both fixed scopes, aggregates dates and status codes, and never returns private financial rows', async () => {
    const f = fixture((query) => {
      const page = Number(query.data.pgeNo ?? 1)
      const rows =
        query.data.slOcDvC === '2'
          ? []
          : Array.from({ length: page === 1 ? 10 : 2 }, (_, i) => row((page - 1) * 10 + i + 1))
      const details = rows.map((_, i) => detail((page - 1) * 10 + i + 1))
      query.success(
        response(
          rows,
          details,
          query.data.slOcDvC === '2' ? 0 : 12,
          page === 1 && rows.length ? 'PRIVATE_CURSOR' : ''
        )
      )
    })
    const before = JSON.stringify(f.condition)
    const result = await probeSamsungCancelDate(f.tab, RANGE)
    expect(result).toMatchObject({
      state: 'ready',
      dateBasis: 'unverified',
      originalPaymentDate: 'not_in_public_contract',
      scopes: [
        {
          scope: 'domestic',
          pages: 2,
          reportedTotal: 12,
          termination: 'count_exhausted',
          statistics: {
            rows: 12,
            detailRows: 12,
            saleDate: { outside: 12 },
            cancellationReceivedDate: { inside: 12 },
            processingDate: { outside: 12 },
            mainStates: { code2: 12 },
            detailStates: { code2: 12 },
            detailJoins: { matched: 12, expectedCountMismatch: 0 }
          }
        },
        { scope: 'overseas', pages: 1, reportedTotal: 0, termination: 'count_exhausted' }
      ]
    })
    expect(f.calls.map((q) => q.service)).toEqual([
      'SHPPRP0801S43',
      'SHPPRP0801S43',
      'SHPPRP0801S43'
    ])
    expect(f.calls[0].data).toEqual({
      cardDvC: '1',
      cardKndC: '01',
      isCstMngtNo: 'PRIVATE_CUSTOMER',
      pssCstMngtNo: 0,
      cardCntrNo: 0,
      inqrStrtdt: '20260801',
      inqrEnddt: '20260804',
      inqrDvC: '0',
      slOcDvC: '1',
      no1PgeSize: 10,
      no1NextKeyCn: '',
      no2NextKeyCn: ''
    })
    expect(f.calls[1].data).toMatchObject({
      pgeNo: 2,
      prtgPrvwYn: '',
      no1NextKeyCn: 'PRIVATE_CURSOR',
      no2NextKeyCn: 'PRIVATE_CURSOR_SECOND'
    })
    expect(f.calls[2].data.slOcDvC).toBe('2')
    expect(JSON.stringify(f.condition)).toBe(before)
    expect(f.dom.window.document.querySelector('input')!.value).toBe('2026.01.01')
    for (const secret of [
      'PRIVATE',
      '918273',
      '12345678',
      '4321',
      '20260701',
      '20260803',
      '20260805',
      'scopeDigest',
      'cursors',
      'cancellationComplete',
      'cancellationEvidence'
    ])
      expect(JSON.stringify(result)).not.toContain(secret)
    for (const call of f.execute.mock.results) {
      const value = await call.value
      expect(JSON.stringify(value ?? null)).not.toMatch(
        /PRIVATE_MERCHANT|PRIVATE_ACCOUNT|918273|12345678|4321/
      )
    }
    expect(f.wc.listenerCount('destroyed')).toBe(0)
  })

  it('keeps malformed dates, processing, benefit recovery, account errors and ambiguous joins as counts only', async () => {
    const rows = [
      {
        ...row(1),
        slDt: '20260230',
        slRcpdt: '20260803',
        canProcsRsC: 'PRIVATE_UNKNOWN',
        procsCt: 2
      },
      { ...row(2), slDt: '', canProcsRsC: null, procsCt: null }
    ]
    const details = [
      { ...detail(1), canPrcsdt: 'bad', poCanProcsRsC: '4' },
      { ...detail(9), canPrcsdt: null, poCanProcsRsC: '5' },
      { ...detail(1), slMngtNo: null, poCanProcsRsC: 'PRIVATE_CODE' }
    ]
    const f = fixture((query) =>
      query.success(query.data.slOcDvC === '1' ? response(rows, details) : response())
    )
    const result = await probeSamsungCancelDate(f.tab, RANGE)
    expect(result.scopes[0].statistics).toMatchObject({
      saleDate: { invalid: 1, missing: 1 },
      mainStates: { other: 1, missing: 1 },
      detailStates: { code4: 1, code5: 1, other: 1 },
      processingDate: { invalid: 1, missing: 1, outside: 1 },
      detailJoins: {
        matched: 1,
        unmatched: 1,
        missing: 1,
        expectedCountMismatch: 1,
        expectedCountMissing: 1
      }
    })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
  })

  it.each([
    'count_overflow',
    'short_page',
    'cursor_missing',
    'cursor_repeated',
    'total_changed',
    'service_error',
    'invalid_response'
  ] as const)('stops unsafe paging with %s without promoting coverage', async (fault) => {
    const f = fixture((query) => {
      if (query.data.slOcDvC === '2') return query.success(response())
      const page = Number(query.data.pgeNo ?? 1)
      if (fault === 'service_error') return query.error('PRIVATE_ERROR_TOKEN')
      if (fault === 'invalid_response')
        return query.success({ common: { procsRsDvC: '0' }, totDlngCt: 'PRIVATE_INVALID_TOTAL' })
      const rows = Array.from({ length: fault === 'short_page' ? 1 : 10 }, (_, i) =>
        row((page - 1) * 10 + i + 1)
      )
      query.success(
        response(
          rows,
          [],
          fault === 'count_overflow' ? 1 : fault === 'total_changed' && page > 1 ? 32 : 31,
          fault === 'cursor_missing' ? '' : 'PRIVATE_REPEATED_CURSOR'
        )
      )
    })
    const result = await probeSamsungCancelDate(f.tab, RANGE)
    expect(result).toMatchObject({
      state: 'partial',
      dateBasis: 'unverified',
      scopes: [{ termination: 'stopped', issue: fault }, { termination: 'count_exhausted' }]
    })
    expect(f.calls.length).toBeLessThanOrEqual(3)
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
  })

  it('bounds all paging even when every cursor changes', async () => {
    const f = fixture((query) =>
      query.success(
        query.data.slOcDvC === '2'
          ? response()
          : response(
              Array.from({ length: 10 }, (_, i) =>
                row((Number(query.data.pgeNo ?? 1) - 1) * 10 + i)
              ),
              [],
              301,
              'CURSOR_' + String(query.data.pgeNo ?? 1)
            )
      )
    )
    const result = await probeSamsungCancelDate(f.tab, RANGE)
    expect(result.scopes[0]).toMatchObject({
      pages: 30,
      termination: 'stopped',
      issue: 'page_limit',
      statistics: { rows: 300 }
    })
    expect(f.calls).toHaveLength(31)
  })

  it.each([
    ['2026-06-30', '2026-07-01'],
    ['2026-08-01', '2026-08-05'],
    ['2026-08-04', '2026-08-01'],
    ['2026-02-30', '2026-02-30'],
    ['9999-01-01', '9999-01-01']
  ])('rejects out-of-policy or invalid range %s..%s before authentication', async (from, to) => {
    const f = fixture()
    expect(await probeSamsungCancelDate(f.tab, { from, to })).toMatchObject({
      state: 'invalid_range',
      issue: 'invalid_range'
    })
    expect(f.auth).not.toHaveBeenCalled()
    expect(f.calls).toHaveLength(0)
  })

  it('uses Korea today rather than UTC when bounding the range', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-07T16:00:00Z'))
    const f = fixture()
    expect(
      (await probeSamsungCancelDate(f.tab, { from: '2026-10-08', to: '2026-10-08' })).state
    ).toBe('ready')
    expect(
      (await probeSamsungCancelDate(f.tab, { from: '2026-10-09', to: '2026-10-09' })).state
    ).toBe('invalid_range')
  })

  it.each(['signed_out', 'scope_changed', 'navigation', 'replacement'] as const)(
    'stops on %s and never queries the second scope',
    async (fault) => {
      const f = fixture((query) => {
        if (fault === 'scope_changed') f.condition.isCstMngtNo = 'PRIVATE_OTHER_CUSTOMER'
        if (fault === 'navigation')
          f.setUrl('https://www.samsungcard.com/personal/login/UHPPCO0301M0.jsp')
        if (fault === 'replacement') f.tab.view.webContents = {} as typeof f.wc
        if (fault === 'signed_out')
          f.auth.mockResolvedValue({ issuer: 'samsung_card', state: 'signed_out' })
        query.success(response([row()], [detail()]))
      })
      const result = await probeSamsungCancelDate(f.tab, RANGE)
      expect(result.issue).toBe(
        fault === 'signed_out'
          ? 'session_unverified'
          : fault === 'scope_changed'
            ? 'card_scope_changed'
            : 'navigation_changed'
      )
      expect(f.calls).toHaveLength(1)
      expect(result.scopes).toHaveLength(1)
      expect(f.wc.listenerCount('destroyed')).toBe(0)
    }
  )

  it.each(['abort', 'destroy', 'main_frame_navigation'] as const)(
    'interrupts a pending page on %s without retrying',
    async (fault) => {
      const f = fixture(() => {})
      const abort = new AbortController()
      const pending = probeSamsungCancelDate(f.tab, RANGE, abort.signal)
      await vi.waitFor(() => expect(f.calls).toHaveLength(1))
      if (fault === 'abort') abort.abort()
      else if (fault === 'destroy') f.destroy()
      else f.wc.emit('did-start-navigation', {}, URL, false, true)
      const result = await pending
      expect(result.issue).toBe(fault === 'abort' ? 'aborted' : 'navigation_changed')
      expect(f.calls).toHaveLength(1)
      expect(f.wc.listenerCount('destroyed')).toBe(0)
    }
  )

  it('does not query a non-history origin or a single-card scope', async () => {
    const f = fixture()
    f.setUrl('https://attacker.example/personal/card/activity/UHPPRP0801M0.jsp')
    expect((await probeSamsungCancelDate(f.tab, RANGE)).issue).toBe('not_history_page')
    f.setUrl(URL)
    f.condition.cardCntrNo = 1
    const result = await probeSamsungCancelDate(f.tab, RANGE)
    expect(result.scopes.every((scope) => scope.issue === 'card_scope_not_all')).toBe(true)
    expect(f.calls).toHaveLength(0)
  })
})
