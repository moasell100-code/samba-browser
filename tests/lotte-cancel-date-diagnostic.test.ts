import { EventEmitter } from 'node:events'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../src/main/browser/tab-manager'
const auth = vi.hoisted(() => vi.fn())
vi.mock('../src/main/browser/page-bridge', () => ({ pageBridge: { cardSession: auth } }))
import { probeLotteCancellationDateBasis } from '../src/main/finance/lotte-cancel-date-diagnostic'

const HISTORY = 'https://www.lottecard.co.kr/app/LPMCDAA_V100.lc'
const QUERY = 'https://www.lottecard.co.kr/app/LPMCDAA_A102.lc'
const DETAIL = 'https://www.lottecard.co.kr/app/LPMCDAA_P103.lc'
// Synthetic constants only. These do not assert any official status codes.
const filterContract = { all: 'A', cancellation: 'C' }
const range = { from: '2026-08-02', to: '2026-08-04' }
const windows: JSDOM[] = []
const fields = [
  'encCdno',
  'endDt',
  'inqTeDt',
  'nextKey',
  'pageNo',
  'pageRows',
  'ptnBnkYn',
  'schDv',
  'sortDv',
  'sortObj',
  'stDv',
  'startDt',
  'uplDv',
  'useCdDv',
  'useDv'
]
const labels = [
  '이용일시',
  '거래유형',
  '승인번호',
  '취소여부',
  '포인트사용',
  '매입여부',
  '취소금액',
  '매입금액',
  '취소일자'
]
const privateMerchant = 'synthetic-private-merchant'
beforeEach(() => {
  auth.mockReset().mockResolvedValue({ issuer: 'lotte_card', state: 'signed_in' })
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-08T03:00:00Z'))
})
afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close()
  vi.useRealTimers()
})
function markup(): string {
  const defaults: Record<string, string> = {
    pageRows: '20',
    pageNo: '1',
    schDv: 'official-default',
    encCdno: 'private-card',
    startDt: 'private-date',
    endDt: 'private-date'
  }
  return `<form name="LPMCDAAAprUseList">${fields.map((name) => `<input name="${name}" value="${defaults[name] ?? ''}">`).join('')}</form><input type="checkbox" id="useCarditemAll"><form name="LPMCDAAArsUseDetail"><input name="mildolYn" value="N"></form>${['useCdDv', 'uplDv', 'useDv', 'stDv'].map((name) => `<label><input type="radio" name="${name}Radio" value="A">전체</label>`).join('')}<label><input type="radio" name="stDvRadio" value="C">취소</label>`
}
type Row = { id?: string; original?: string; cancelled?: string; partial?: boolean; lazy?: boolean }
function detail(options: Row = {}): string {
  const values = [
    (options.original ?? '2026-08-03').replaceAll('-', '.') + ' 12:34:56',
    '일시불',
    options.id ?? 'SYNTH-PRIVATE-ID',
    options.partial ? '부분취소' : '취소',
    '0원',
    '매입',
    options.partial ? '3,001원' : '10,009원',
    '10,009원',
    (options.cancelled ?? '2026-08-20').replaceAll('-', '.')
  ]
  return `<ul>${labels.map((label, i) => `<li>${label}<span>${values[i]}</span></li>`).join('')}</ul>`
}
function row(options: Row = {}): string {
  const original = options.original ?? '2026-08-03'
  const payload = {
    aprDeAm: '10009',
    aprDeKeyV: 'private-key',
    aprDtti: original.replaceAll('-', '') + '123456',
    cdno: 'private-card-reference',
    deDt: '',
    gramFlwSeq: '1',
    auPartId: '1',
    aprno: options.id ?? 'SYNTH-PRIVATE-ID',
    aprTrc: '0',
    byRc: '0',
    byCanRc: '0',
    mcNm: privateMerchant,
    aprRsc: '0'
  }
  const button = options.lazy
    ? `<button data-object="${JSON.stringify(payload).replaceAll('"', '&quot;')}"></button>`
    : ''
  return `<li class="toggle${options.partial ? '' : ' cancel'}"><strong>${privateMerchant}</strong><div class="info"><span>${original.replaceAll('-', '.')}</span><span>synthetic-card(9876)</span><span>일시불</span><span>${options.partial ? '부분취소(-3,001원)' : '취소'}</span></div><em${options.partial ? ' class="parttot"' : ''}><span>10,009원</span>${options.partial ? '<span>7,008원</span>' : ''}</em>${button}<div class="useList">${options.lazy ? '' : detail(options)}</div></li>`
}
function envelope(
  content: string,
  pageNo = 1,
  totalPage = 1,
  param: Record<string, unknown> = {}
): unknown {
  return {
    Status: { code: 0 },
    Content: content,
    Param: { pageNo, totalPage, nextPageNo: pageNo + 1, ...param }
  }
}
function fixture(
  respond: (url: string, body: URLSearchParams) => unknown = () =>
    envelope('<div class="noData">이용내역이 없습니다.</div>', 1, 0)
): {
  tab: Tab
  dom: JSDOM
  wc: EventEmitter & {
    getURL: () => string
    isDestroyed: () => boolean
    executeJavaScript: ReturnType<typeof vi.fn>
    session: { fetch: ReturnType<typeof vi.fn> }
  }
} {
  const dom = new JSDOM(markup(), { url: HISTORY, runScripts: 'outside-only' })
  windows.push(dom)
  const wc = new EventEmitter() as EventEmitter & {
    getURL: () => string
    isDestroyed: () => boolean
    executeJavaScript: ReturnType<typeof vi.fn>
    session: { fetch: ReturnType<typeof vi.fn> }
  }
  wc.getURL = () => HISTORY
  wc.isDestroyed = () => false
  wc.executeJavaScript = vi.fn(async (script: string) => dom.window.eval(script))
  wc.session = {
    fetch: vi.fn(
      async (url: string, options: { body: string }) =>
        new Response(JSON.stringify(await respond(url, new URLSearchParams(options.body))), {
          headers: { 'content-type': 'application/json' }
        })
    )
  }
  const tab = { profile: 'synthetic-profile', view: { webContents: wc } } as unknown as Tab
  return { tab, wc, dom }
}
describe('Lotte cancellation date diagnostic read-only boundary', () => {
  it.each([
    undefined,
    { all: 'A', cancellation: 'A' },
    { all: 'A', cancellation: 'arbitrary' },
    { all: '0', cancellation: '1' }
  ])('blocks absent or unverified static contracts: %j', async (contract) => {
    const { tab, wc } = fixture()
    const result = await probeLotteCancellationDateBasis(tab, range, { filterContract: contract })
    expect(result.filterVerified).toBe(false)
    expect(result.all.failureCounts.filter_unverified).toBe(1)
    expect(wc.session.fetch).not.toHaveBeenCalled()
  })
  it.each([
    { from: '2026-08-01', to: '2026-08-05' },
    { from: '2026-06-30', to: '2026-07-01' },
    { from: '2026-10-08', to: '2026-10-09' },
    { from: 'private-input', to: '2026-08-02' }
  ])('rejects invalid/unapproved ranges: %j', async (invalid) => {
    const { tab, wc } = fixture()
    const result = await probeLotteCancellationDateBasis(tab, invalid, { filterContract })
    expect(result.all.failureCounts.invalid_range).toBe(1)
    expect(wc.session.fetch).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('private-input')
  })
  it('requires a unique explicit static cancellation value, even when its DOM property matches', async () => {
    for (const mutation of [
      (dom: JSDOM) =>
        dom.window.document.querySelector('input[value="C"]')!.removeAttribute('value'),
      (dom: JSDOM) =>
        dom.window.document.body.insertAdjacentHTML(
          'beforeend',
          '<label><input type="radio" name="stDvRadio" value="C">취소</label>'
        )
    ]) {
      const { tab, wc, dom } = fixture()
      mutation(dom)
      const result = await probeLotteCancellationDateBasis(tab, range, { filterContract })
      expect(result.all.failureCounts.filter_unverified).toBe(1)
      expect(wc.session.fetch).not.toHaveBeenCalled()
    }
  })
  it('compares all pages of the fixed scopes, retains schDv and returns dates/counts without private fields', async () => {
    const queries: URLSearchParams[] = []
    const { tab, wc, dom } = fixture((url, body) => {
      expect(url).toBe(QUERY)
      queries.push(body)
      if (body.get('pageNo') === '1')
        return envelope(row({ id: 'SYNTH-PRIVATE-1' }), 1, 2, {
          stDv: body.get('stDv'),
          startDt: '20260802',
          endDt: '20260804',
          schDv: 'official-default',
          nextKey: 'server-next-cursor'
        })
      return envelope(
        row({
          id: 'SYNTH-PRIVATE-2',
          original: '2026-07-04',
          cancelled: '2026-08-03',
          partial: true
        }),
        2,
        2
      )
    })
    const before = dom.window.document.documentElement.outerHTML
    const result = await probeLotteCancellationDateBasis(tab, range, { filterContract })
    expect(result.filterVerified).toBe(true)
    for (const scope of [result.all, result.cancellation])
      expect(scope).toMatchObject({
        paginationComplete: true,
        pages: 2,
        rows: 2,
        fullRows: 1,
        partialRows: 1,
        approvalDateInside: 1,
        approvalDateOutside: 1,
        cancellationDateInside: 1,
        cancellationDateOutside: 1,
        cancellationDateUnknown: 0,
        datePairs: {
          bothInside: 0,
          approvalOnlyInside: 1,
          cancellationOnlyInside: 1,
          bothOutside: 0
        }
      })
    expect(queries.map((body) => [body.get('stDv'), body.get('pageNo')])).toEqual([
      ['A', '1'],
      ['A', '2'],
      ['C', '1'],
      ['C', '2']
    ])
    for (const body of queries) {
      expect([...body.keys()].sort()).toEqual([...fields].sort())
      expect(body.get('schDv')).toBe('official-default')
      expect(body.get('encCdno')).toBe('')
    }
    expect(dom.window.document.documentElement.outerHTML).toBe(before)
    expect(JSON.stringify(result)).not.toMatch(
      /private|10009|10,009|9876|aprno|encCdno|mcNm|official-default/
    )
    expect(wc.listenerCount('did-start-navigation')).toBe(0)
    expect(wc.listenerCount('destroyed')).toBe(0)
  })
  it('reads only the known P103 shape and keeps missing proof unknown', async () => {
    for (const truncated of [false, true]) {
      const { tab, wc } = fixture((url) =>
        url === QUERY
          ? envelope(row({ lazy: true }))
          : {
              Status: { code: 0 },
              Content: truncated ? detail().replace(/<li>취소금액[\s\S]*<\/ul>/, '</ul>') : detail()
            }
      )
      const result = await probeLotteCancellationDateBasis(tab, range, { filterContract })
      expect(result.all.paginationComplete).toBe(true)
      expect(result.all.cancellationDateOutside).toBe(truncated ? 0 : 1)
      expect(result.all.cancellationDateUnknown).toBe(truncated ? 1 : 0)
      expect(wc.session.fetch.mock.calls.filter((call) => call[0] === DETAIL)).toHaveLength(2)
      expect(JSON.stringify(result)).not.toContain('SYNTH-PRIVATE-ID')
    }
  })
  it.each(['page', 'total', 'echo', 'next', 'rows'])(
    'fails a malformed %s scope safely and still probes the other scope',
    async (kind) => {
      const { tab } = fixture((_url, body) => {
        if (body.get('stDv') === 'C') return envelope(row())
        if (kind === 'rows') return envelope(row() + row())
        return envelope(
          row(),
          1,
          kind === 'next' ? 2 : 1,
          kind === 'page'
            ? { pageNo: true }
            : kind === 'total'
              ? { totalPage: null }
              : kind === 'echo'
                ? { stDv: 'C' }
                : { nextPageNo: 1 }
        )
      })
      const result = await probeLotteCancellationDateBasis(tab, range, { filterContract })
      expect(result.all.paginationComplete).toBe(false)
      expect(Object.values(result.all.failureCounts).reduce((a, b) => a + b, 0)).toBeGreaterThan(0)
      expect(result.cancellation.paginationComplete).toBe(true)
    }
  )
  it('stops on scope change and session loss rather than accepting a response', async () => {
    const { tab, wc, dom } = fixture(() => {
      dom.window.document.querySelector<HTMLInputElement>('input[name="schDv"]')!.value = 'changed'
      return envelope(row())
    })
    const result = await probeLotteCancellationDateBasis(tab, range, { filterContract })
    expect(result.all.failureCounts.scope_changed).toBe(1)
    expect(result.cancellation.failureCounts.scope_changed).toBe(1)
    expect(wc.session.fetch).toHaveBeenCalledTimes(1)
    auth.mockResolvedValue({ issuer: 'lotte_card', state: 'signed_out' })
    const second = fixture()
    const blocked = await probeLotteCancellationDateBasis(second.tab, range, { filterContract })
    expect(blocked.all.failureCounts.session_unverified).toBe(1)
    expect(second.wc.session.fetch).not.toHaveBeenCalled()
  })
  it('aborts a pending main-frame navigation and releases listeners', async () => {
    const { tab, wc } = fixture()
    wc.session.fetch.mockImplementation(() => new Promise(() => {}))
    const run = probeLotteCancellationDateBasis(tab, range, { filterContract })
    await vi.waitFor(() => expect(wc.session.fetch).toHaveBeenCalled(), { interval: 1 })
    wc.emit('did-start-navigation', {}, HISTORY, false, true)
    const result = await run
    expect(result.all.failureCounts.navigation_changed).toBe(1)
    expect(result.all.paginationComplete).toBe(false)
    expect(wc.listenerCount('did-start-navigation')).toBe(0)
    expect(wc.listenerCount('destroyed')).toBe(0)
  })
})
