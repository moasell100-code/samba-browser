import { describe, expect, it, vi } from 'vitest'
import type { Tab } from '../src/main/browser/tab-manager'
const auth = vi.hoisted(() => vi.fn())
vi.mock('../src/main/browser/page-bridge', () => ({ pageBridge: { cardSession: auth } }))
import {
  collectLotteApi,
  parseLotteApiResponse,
  requestLotteApiPage,
  type LotteApiForm
} from '../src/main/finance/lotte-api-collector'

const URL = 'https://www.lottecard.co.kr/app/LPMCDAA_V100.lc'
function content(
  options: {
    approval?: string
    kind?: 'cancelled' | 'partial'
    refund?: string
    cancelDate?: string
    merchant?: string
    details?: boolean
  } = {}
): string {
  const kind = options.kind
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
  const values = [
    '2026.10.02 12:34:56',
    '일시불',
    options.approval ?? 'SYNTH-001',
    kind ? '취소' : '정상',
    '0원',
    '매입',
    options.refund ?? (kind === 'cancelled' ? '10,000원' : kind ? '3,000원' : '0원'),
    '10,000원',
    options.cancelDate ?? (kind ? '2026.10.03' : '-')
  ]
  const detail =
    options.details === false
      ? ''
      : `<div class="useList" style="display:none"><ul>${labels.map((label, i) => `<li>${label}<input value="not-a-business-value"><span>${values[i]}</span></li>`).join('')}</ul></div>`
  return `<li class="toggle${kind === 'cancelled' ? ' cancel' : ''}"><strong>${options.merchant ?? '합성가맹점'}</strong><div class="info"><span>2026.10.02</span><span>합성카드(1234)</span><span>일시불</span>${kind ? `<span>${kind === 'cancelled' ? '취소' : '부분취소(-3,000원)'}</span>` : ''}</div><em${kind === 'partial' ? ' class="parttot"' : ''}><span>10,000원</span>${kind === 'partial' ? '<span>7,000원</span>' : ''}</em>${detail}</li>`
}
function response(html = content()): unknown {
  return { Status: { code: 0 }, Content: html }
}
function tab(url = URL): Tab {
  return {
    view: {
      webContents: { isDestroyed: () => false, getURL: () => url, executeJavaScript: vi.fn() }
    }
  } as unknown as Tab
}

describe('Lotte private API normalization', () => {
  it('normalizes verified transaction fields and labelled server-supplied details without input values', () => {
    const result = parseLotteApiResponse(response())
    expect(result.issues).toEqual([])
    expect(result.rowCount).toBe(1)
    expect(result.rows[0]).toMatchObject({
      issuer: 'lotte_card',
      kind: 'approval',
      approvedAt: '2026-10-02T12:34:56+09:00',
      approvalNumber: 'SYNTH-001',
      cardLast4: '1234',
      merchant: '합성가맹점',
      amount: 10000,
      currency: 'KRW',
      status: 'approved',
      cancellationAmount: null,
      netAmount: 10000,
      needsReview: []
    })
    expect(JSON.stringify(result)).not.toMatch(/not-a-business-value|<li|useList/)
  })
  it('keeps the same approval identity after a later full or partial cancellation', () => {
    const approved = parseLotteApiResponse(response()).rows[0]
    const cancelled = parseLotteApiResponse(response(content({ kind: 'cancelled' }))).rows[0]
    const partial = parseLotteApiResponse(response(content({ kind: 'partial' }))).rows[0]
    expect(cancelled.sourceId).toBe(approved.sourceId)
    expect(partial.sourceId).toBe(approved.sourceId)
    expect(cancelled).toMatchObject({
      kind: 'status',
      status: 'cancelled',
      cancellationAmount: 10000,
      netAmount: 0,
      eventDate: '2026-10-03'
    })
    expect(partial).toMatchObject({
      status: 'partially_cancelled',
      cancellationAmount: 3000,
      netAmount: null,
      needsReview: ['partial_original_amount_unverified']
    })
  })
  it('keeps different approvals distinct even with identical merchant/date/card/amount', () => {
    const result = parseLotteApiResponse(response(content() + content({ approval: 'SYNTH-002' })))
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0].sourceId).not.toBe(result.rows[1].sourceId)
  })
  it('preserves repeated identity rows for review rather than dropping potentially real transactions', () => {
    const result = parseLotteApiResponse(response(content() + content()))
    expect(result.rows).toHaveLength(2)
    expect(result.issues).toContain('duplicate_identity_in_page')
    expect(result.rows.every((row) => row.needsReview.includes('duplicate_identity_in_page'))).toBe(
      true
    )
  })
  it('does not identify a transaction from an unlabelled or absent approval value', () => {
    const result = parseLotteApiResponse(response(content({ details: false })))
    expect(result.rows[0].approvalNumber).toBeUndefined()
    expect(result.rows[0].needsReview).toEqual(['details_unverified', 'identity_unverified'])
  })
  it('does not infer a full refund from cancellation status alone', () => {
    const row = parseLotteApiResponse(response(content({ kind: 'cancelled', refund: '-' }))).rows[0]
    expect(row.cancellationAmount).toBeNull()
    expect(row.netAmount).toBeNull()
    expect(row.needsReview).toContain('cancellation_amount_unverified')
  })
  it('flags disagreement between explicit cancellation amount and exact partial-cancellation label', () => {
    const row = parseLotteApiResponse(response(content({ kind: 'partial', refund: '4,000원' })))
      .rows[0]
    expect(row.cancellationAmount).toBeNull()
    expect(row.netAmount).toBeNull()
    expect(row.needsReview).toContain('cancellation_amount_conflict')
  })
  it('rejects malformed dates/amounts and keeps valid rows from the same structurally valid page', () => {
    const invalid = content({ approval: 'SYNTH-002' }).replace(
      '<span>2026.10.02</span>',
      '<span>2026.02.30</span>'
    )
    const result = parseLotteApiResponse(response(content() + invalid))
    expect(result.rows).toHaveLength(1)
    expect(result.issues).toContain('unrecognized_rows')
    const malformed = parseLotteApiResponse(
      response(content().replace('<span>10,000원</span>', '<span>10,00원</span>'))
    )
    expect(malformed.rows).toEqual([])
    expect(malformed.issues).toContain('unrecognized_rows')
  })
  it('handles a verified empty full root without inventing rows', () => {
    expect(
      parseLotteApiResponse(response('<ul id="useCardList" class="useCardList type02"></ul>'))
    ).toEqual({ rows: [], issues: [], rowCount: 0 })
    expect(parseLotteApiResponse(response('')).issues).toContain('response_schema_unverified')
  })
  it('rejects an error envelope or unknown response shape', () => {
    expect(
      parseLotteApiResponse({
        Status: { code: -1, message: 'private response' },
        Content: content()
      })
    ).toEqual({ rows: [], issues: ['response_status_unverified'], rowCount: null })
    expect(
      parseLotteApiResponse({ Status: { code: 0 }, Content: '<div>private data</div>' })
    ).toEqual({ rows: [], issues: ['response_schema_unverified'], rowCount: null })
  })
  it('does not execute script content or read input attributes in a displayed heading', () => {
    const row = parseLotteApiResponse(
      response(
        content({
          merchant: '합성<script>throw Error("secret")</script><input value="secret">가맹점'
        })
      )
    ).rows[0]
    expect(row.merchant).toBe('합성가맹점')
  })
})

describe('Lotte API collector boundary before query-contract verification', () => {
  it('never claims complete or sends an API request without verified paging/filter semantics', async () => {
    auth.mockResolvedValue({ issuer: 'lotte_card', state: 'signed_in' })
    const current = tab()
    const result = await collectLotteApi(current, { from: '2026-09-29', to: '2026-10-02' })
    expect(result.rows).toEqual([])
    expect(result.receipt).toMatchObject({
      complete: false,
      pages: 0,
      issues: [
        'request_schema_unverified',
        'pagination_unverified',
        'cancellation_query_basis_unverified'
      ]
    })
    expect(current.view.webContents.executeJavaScript).not.toHaveBeenCalled()
  })
  it('refuses a different origin/path, unauthenticated session, invalid range, or prior cancellation', async () => {
    const range = { from: '2026-09-29', to: '2026-10-02' }
    for (const url of [
      'https://www.lottecard.co.kr.evil.test/app/LPMCDAA_V100.lc',
      'https://www.lottecard.co.kr/app/LPMANAA_V200.lc'
    ]) {
      expect((await collectLotteApi(tab(url), range)).receipt.issues).toEqual([
        'history_page_required'
      ])
    }
    auth.mockResolvedValue({ issuer: 'lotte_card', state: 'signed_out' })
    expect((await collectLotteApi(tab(), range)).receipt.issues).toEqual([
      'authentication_required'
    ])
    expect(
      (await collectLotteApi(tab(), { from: '2026-02-30', to: range.to })).receipt.issues
    ).toEqual(['invalid_range'])
    expect(
      (await collectLotteApi(tab(), range, { signal: AbortSignal.abort() })).receipt.issues
    ).toEqual(['cancelled'])
  })
})

describe('fixed private Lotte API transport', () => {
  const form: LotteApiForm = {
    encCdno: '',
    endDt: '20261002',
    inqTeDt: '',
    nextKey: '',
    pageNo: '1',
    pageRows: '20',
    ptnBnkYn: '',
    schDv: '',
    sortDv: '',
    sortObj: '',
    stDv: '',
    startDt: '20260929',
    uplDv: '',
    useCdDv: '',
    useDv: ''
  }
  // Form values here are synthetic transport fixtures, not assumptions about the live query.
  function transportFixture(): {
    current: Tab
    fetch: ReturnType<typeof vi.fn>
    change: () => void
  } {
    let currentUrl = URL
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(response()), { headers: { 'Content-Type': 'text/html' } })
    )
    const current = {
      view: {
        webContents: { isDestroyed: () => false, getURL: () => currentUrl, session: { fetch } }
      }
    } as unknown as Tab
    return {
      current,
      fetch,
      change: () => {
        currentUrl = 'https://www.lottecard.co.kr/app/LPMANAA_V200.lc'
      }
    }
  }
  it('posts only to A102 using the current tab session and parses JSON despite HTML MIME', async () => {
    auth.mockResolvedValue({ issuer: 'lotte_card', state: 'signed_in' })
    const h = transportFixture()
    expect(await requestLotteApiPage(h.current, form)).toEqual(response())
    expect(h.fetch).toHaveBeenCalledWith(
      'https://www.lottecard.co.kr/app/LPMCDAA_A102.lc',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        redirect: 'error',
        body: new URLSearchParams(form).toString()
      })
    )
  })
  it('refuses extra fields, accessor values, oversized cursor, and an aborted request', async () => {
    const h = transportFixture()
    const accessor = { ...form }
    Object.defineProperty(accessor, 'encCdno', {
      get: () => {
        throw new Error('must not evaluate')
      }
    })
    for (const invalid of [
      { ...form, url: 'https://invalid.test' },
      accessor,
      { ...form, nextKey: 'x'.repeat(8193) }
    ]) {
      await expect(requestLotteApiPage(h.current, invalid)).rejects.toThrow('lotte_request_invalid')
    }
    await expect(requestLotteApiPage(h.current, form, AbortSignal.abort())).rejects.toThrow(
      'lotte_request_cancelled'
    )
    expect(h.fetch).not.toHaveBeenCalled()
  })
  it('does not return response bodies after navigation or authentication changes', async () => {
    const h = transportFixture()
    auth.mockResolvedValue({ issuer: 'lotte_card', state: 'signed_in' })
    h.fetch.mockImplementationOnce(async () => {
      h.change()
      return new Response('private response')
    })
    await expect(requestLotteApiPage(h.current, form)).rejects.toThrow('lotte_request_unavailable')
    const second = transportFixture()
    auth
      .mockResolvedValueOnce({ issuer: 'lotte_card', state: 'signed_in' })
      .mockResolvedValueOnce({ issuer: 'lotte_card', state: 'signed_out' })
    await expect(requestLotteApiPage(second.current, form)).rejects.toThrow(
      'lotte_request_unavailable'
    )
  })
  it('bounds response bytes and keeps malformed body errors fixed', async () => {
    auth.mockResolvedValue({ issuer: 'lotte_card', state: 'signed_in' })
    for (const body of ['x'.repeat(2 * 1024 * 1024 + 1), 'private malformed response']) {
      const h = transportFixture()
      h.fetch.mockResolvedValueOnce(new Response(body))
      await expect(requestLotteApiPage(h.current, form)).rejects.toThrow(
        /^lotte_request_unavailable$/
      )
    }
  })
})
