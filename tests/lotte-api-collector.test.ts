import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
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
const windows: JSDOM[] = []
beforeEach(() => {
  auth.mockReset().mockResolvedValue({ issuer: 'lotte_card', state: 'signed_in' })
})
afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close()
  vi.useRealTimers()
})
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
function lazyContent(payloadOverrides: Record<string, unknown> = {}): string {
  const payload = {
    aprDeAm: '10000',
    aprDeKeyV: 'synthetic-private-key',
    aprDtti: '20261002123456',
    cdno: 'synthetic-private-card',
    deDt: '20261002',
    gramFlwSeq: '1',
    auPartId: '1',
    aprno: 'SYNTH-001',
    aprTrc: '0',
    byRc: 'synthetic-code',
    byCanRc: 'synthetic-code',
    mcNm: '합성가맹점',
    aprRsc: '0',
    ...payloadOverrides
  }
  const encoded = JSON.stringify(payload).replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  return content({ details: false }).replace(
    '</li>',
    `<button data-type="synthetic" data-object="${encoded}"></button><div class="useList"></div></li>`
  )
}
function detailEnvelope(options: Parameters<typeof content>[0] = {}): unknown {
  return response(content(options).match(/<ul>[\s\S]*<\/ul>/)![0])
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
  it.each(['1,000원', '-1,000원'])(
    'does not approve a normal header with a nonzero detail refund (%s)',
    (refund) => {
      const row = parseLotteApiResponse(response(content({ refund }))).rows[0]
      expect(row.status).toBe('unknown')
      expect(row.netAmount).toBeNull()
      expect(row.needsReview).toContain('cancellation_state_conflict')
    }
  )
  it('does not approve contradictory detail cancellation labels or a cancellation date', () => {
    for (const html of [
      content().replace('<span>정상</span>', '<span>취소완료</span>'),
      content({ cancelDate: '2026.10.03' })
    ]) {
      const row = parseLotteApiResponse(response(html)).rows[0]
      expect(row.status).toBe('unknown')
      expect(row.needsReview).toContain('cancellation_state_conflict')
    }
  })
  it('retains loan, missing KRW unit, and conflicting transaction labels for review', () => {
    const loan = parseLotteApiResponse(response(content().replaceAll('일시불', '단기카드대출')))
      .rows[0]
    expect(loan.needsReview).toContain('transaction_type_unverified')
    const noUnit = parseLotteApiResponse(
      response(content().replace('<span>10,000원</span>', '<span>10,000</span>'))
    ).rows[0]
    expect(noUnit.needsReview).toContain('currency_unverified')
    const conflict = parseLotteApiResponse(
      response(
        content().replace(
          '거래유형<input value="not-a-business-value"><span>일시불</span>',
          '거래유형<input value="not-a-business-value"><span>할부</span>'
        )
      )
    ).rows[0]
    expect(conflict.needsReview).toContain('transaction_type_conflict')
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

const FORM: LotteApiForm = {
  encCdno: 'private-selected-card',
  endDt: '20260101',
  inqTeDt: '0',
  nextKey: 'private-old-cursor',
  pageNo: '7',
  pageRows: '20',
  ptnBnkYn: 'N',
  schDv: '',
  sortDv: '7',
  sortObj: '0',
  stDv: 'X',
  startDt: '20260101',
  uplDv: 'X',
  useCdDv: 'X',
  useDv: 'X'
}
const RANGE = { from: '2026-09-29', to: '2026-10-02' }
function envelope(
  pageNo = 1,
  totalPage = 1,
  html = content(),
  param: Record<string, unknown> = {}
): unknown {
  return {
    Status: { code: 0 },
    Content: html,
    Param: { pageNo, totalPage, nextPageNo: pageNo + 1, ...param }
  }
}
function collectorFixture(responses: unknown[] = [envelope()]): {
  dom: JSDOM
  current: Tab
  fetch: ReturnType<typeof vi.fn>
  execute: ReturnType<typeof vi.fn>
  navigate: () => void
} {
  const html = `<form name="LPMCDAAAprUseList">${Object.entries(FORM)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${value}">`)
    .join('')}</form>
    <form name="LPMCDAAArsUseDetail"><input name="mildolYn" value="synthetic-default"></form>
    <input type="checkbox" id="useCarditemAll">
    ${['useCdDv', 'uplDv', 'useDv', 'stDv'].map((name) => `<label><input type="radio" name="${name}Radio" value="A_${name}">전체</label><label><input type="radio" name="${name}Radio" value="selected" checked>다른 옵션</label>`).join('')}`
  const dom = new JSDOM(html, { url: URL, runScripts: 'outside-only' })
  windows.push(dom)
  let url = URL
  const execute = vi.fn(async (script: string, userGesture: boolean) => {
    expect(userGesture).toBe(false)
    return dom.window.eval(script)
  })
  let index = 0
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(responses[index++]), { headers: { 'Content-Type': 'text/html' } })
  )
  const current = {
    view: {
      webContents: {
        isDestroyed: () => false,
        getURL: () => url,
        executeJavaScript: execute,
        session: { fetch }
      }
    }
  } as unknown as Tab
  return {
    dom,
    current,
    fetch,
    execute,
    navigate: () => {
      url = 'https://www.lottecard.co.kr/app/LPMANAA_V200.lc'
    }
  }
}

describe('Lotte verified all-option and Param pagination collector', () => {
  it('enriches a lazy row using its exact official P103 form and matching labelled response', async () => {
    const h = collectorFixture([envelope(1, 1, lazyContent()), detailEnvelope()])
    const before = h.dom.window.document.body.innerHTML
    const result = await collectLotteApi(h.current, RANGE)
    expect(result.rows[0]).toMatchObject({
      approvalNumber: 'SYNTH-001',
      approvedAt: '2026-10-02T12:34:56+09:00',
      needsReview: [],
      status: 'approved'
    })
    expect(result.receipt.approvalComplete).toBe(true)
    expect(h.fetch).toHaveBeenCalledTimes(2)
    expect(h.fetch.mock.calls[1][0]).toBe('https://www.lottecard.co.kr/app/LPMCDAA_P103.lc')
    const options = h.fetch.mock.calls[1][1]
    expect(options).toMatchObject({ method: 'POST', credentials: 'include', redirect: 'error' })
    const sent = Object.fromEntries(new URLSearchParams(options.body))
    expect(Object.keys(sent)).toHaveLength(16)
    expect(sent).toMatchObject({
      aprno: 'SYNTH-001',
      encCdno: 'synthetic-private-card',
      mildolYn: 'synthetic-default',
      lono: '',
      type: ''
    })
    expect(sent).not.toHaveProperty('cdno')
    expect(h.dom.window.document.body.innerHTML).toBe(before)
    expect(JSON.stringify(result.receipt)).not.toMatch(/SYNTH|synthetic|합성|1234/)
    expect(JSON.stringify(result.rows)).not.toMatch(/synthetic-private|aprDeKeyV/)
  })
  it('does not attach another merchant payload with the same approval date and amount', async () => {
    const h = collectorFixture([envelope(1, 1, lazyContent({ mcNm: '다른 합성 가맹점' }))])
    const result = await collectLotteApi(h.current, RANGE)
    expect(result.receipt.issues).toContain('detail_merchant_conflict')
    expect(result.rows[0].needsReview).toContain('detail_request_unverified')
    expect(result.rows[0].approvalNumber).toBeUndefined()
    expect(h.fetch).toHaveBeenCalledTimes(1)
  })
  it('matches the proven compact millisecond timestamp to displayed seconds without changing the P103 parameter', async () => {
    const h = collectorFixture([
      envelope(1, 1, lazyContent({ aprDtti: '20261002123456123' })),
      detailEnvelope()
    ])
    const result = await collectLotteApi(h.current, RANGE)
    expect(result.rows[0]).toMatchObject({
      approvalNumber: 'SYNTH-001',
      approvedAt: '2026-10-02T12:34:56+09:00',
      needsReview: []
    })
    expect(result.receipt.approvalComplete).toBe(true)
    expect(new URLSearchParams(h.fetch.mock.calls[1][1].body).get('aprDtti')).toBe(
      '20261002123456123'
    )
  })
  it('rejects malformed compact fractions, invalid calendar/time, and another approval date', async () => {
    for (const [aprDtti, reason] of [
      ['2026100212345612', 'detail_approval_date_format_unverified'],
      ['202610021234561234', 'detail_approval_date_format_unverified'],
      ['20260230123456123', 'detail_approval_date_format_unverified'],
      ['20261002243456123', 'detail_approval_date_format_unverified'],
      ['20261002126056123', 'detail_approval_date_format_unverified'],
      ['20261001123456123', 'detail_approval_date_conflict']
    ]) {
      const h = collectorFixture([envelope(1, 1, lazyContent({ aprDtti }))])
      const result = await collectLotteApi(h.current, RANGE)
      expect(result.receipt.issues).toContain(reason)
      expect(h.fetch).toHaveBeenCalledTimes(1)
    }
  })
  it('keeps verified approval coverage when only another row has a noninterrupting detail failure', async () => {
    const h = collectorFixture([
      envelope(1, 1, lazyContent() + lazyContent({ aprno: 'SYNTH-002' })),
      detailEnvelope(),
      response('<form>unrecognized synthetic details</form>')
    ])
    const result = await collectLotteApi(h.current, RANGE)
    expect(result.receipt.approvalComplete).toBe(true)
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0].needsReview).toEqual([])
    expect(result.rows[1].needsReview).toContain('detail_response_schema_unverified')
    expect(result.receipt.issues).toContain('detail_response_schema_unverified')
    expect(result.receipt.complete).toBe(false)
  })
  it.each([
    { name: 'different approval', detail: detailEnvelope({ approval: 'OTHER-SYNTH' }) },
    {
      name: 'different timestamp',
      detail: response(
        (detailEnvelope() as { Content: string }).Content.replace('12:34:56', '12:34:57')
      )
    }
  ])('keeps a lazy row for review when P103 refers to a $name', async ({ detail }) => {
    const result = await collectLotteApi(
      collectorFixture([envelope(1, 1, lazyContent()), detail]).current,
      RANGE
    )
    expect(result.rows[0].approvalNumber).toBeUndefined()
    expect(result.rows[0].needsReview).toEqual(
      expect.arrayContaining(['details_unverified', 'detail_identity_conflict'])
    )
  })
  it('uses labelled detail cancellation evidence even when the lazy list header appears normal', async () => {
    const result = await collectLotteApi(
      collectorFixture([envelope(1, 1, lazyContent()), detailEnvelope({ refund: '-1,000원' })])
        .current,
      RANGE
    )
    expect(result.rows[0]).toMatchObject({ status: 'unknown', netAmount: null })
    expect(result.rows[0].needsReview).toContain('cancellation_state_conflict')
  })
  it.each([
    {
      name: 'loan detail route',
      payload: { aprTrc: '20' },
      reason: 'detail_transaction_code_unverified'
    },
    {
      name: 'wrong original date',
      payload: { aprDtti: '20260928123456' },
      reason: 'detail_approval_date_conflict'
    },
    {
      name: 'unknown date format',
      payload: { aprDtti: 'private invalid date' },
      reason: 'detail_approval_date_format_unverified'
    },
    {
      name: 'conflicting amount',
      payload: { aprDeAm: '9999' },
      reason: 'detail_approval_amount_conflict'
    },
    {
      name: 'unknown amount format',
      payload: { aprDeAm: 'private invalid amount' },
      reason: 'detail_approval_amount_format_unverified'
    },
    {
      name: 'missing card reference',
      payload: { cdno: '' },
      reason: 'detail_card_reference_unverified'
    },
    {
      name: 'nested approval value',
      payload: { aprno: { value: 'SYNTH-001' } },
      reason: 'detail_field_type_aprno'
    },
    {
      name: 'oversized known field',
      payload: { aprRsc: 'X'.repeat(129) },
      reason: 'detail_field_format_aprRsc'
    }
  ])('does not request P103 for $name', async ({ payload, reason }) => {
    const h = collectorFixture([envelope(1, 1, lazyContent(payload))])
    const result = await collectLotteApi(h.current, RANGE)
    expect(result.rows[0].needsReview).toContain('detail_request_unverified')
    expect(result.receipt.issues).toContain(reason)
    expect(JSON.stringify(result.receipt)).not.toMatch(/SYNTH|private|synthetic/)
    expect(h.fetch).toHaveBeenCalledTimes(1)
  })
  it('requires a unique direct button payload followed by its own empty details box', async () => {
    const sample = lazyContent()
    for (const html of [
      sample.replace('<button ', '<a ').replace('</button>', '</a>'),
      sample.replace('</button>', '</button><span>unrelated</span>'),
      sample.replace('</li>', '<button data-object="{}"></button></li>')
    ]) {
      const h = collectorFixture([envelope(1, 1, html)])
      const result = await collectLotteApi(h.current, RANGE)
      expect(result.rows[0].needsReview).toContain('detail_request_unverified')
      expect(h.fetch).toHaveBeenCalledTimes(1)
    }
  })
  it('reports fixed structural reasons without exposing payload data', async () => {
    const sample = lazyContent()
    const cases = [
      [
        sample.replace('<button ', '<a ').replace('</button>', '</a>'),
        'detail_payload_tag_unverified'
      ],
      [
        sample.replace('</button>', '</button><span>unrelated</span>'),
        'detail_payload_sibling_unverified'
      ],
      [
        sample.replace('</li>', '<button data-object="{}"></button></li>'),
        'detail_payload_count_unverified'
      ],
      [
        sample.replace('<button ', '<div><button ').replace('</button>', '</button></div>'),
        'detail_payload_parent_unverified'
      ],
      [
        sample.replace(/data-object="[^"]*"/, 'data-object="private-invalid-json"'),
        'detail_payload_json_unverified'
      ]
    ]
    for (const [html, reason] of cases) {
      const result = await collectLotteApi(collectorFixture([envelope(1, 1, html)]).current, RANGE)
      expect(result.receipt.issues).toContain(reason)
      expect(JSON.stringify(result.receipt)).not.toContain('private-invalid-json')
    }
    const h = collectorFixture([envelope(1, 1, sample)])
    h.dom.window.document.querySelector('form[name="LPMCDAAArsUseDetail"]')!.remove()
    expect((await collectLotteApi(h.current, RANGE)).receipt.issues).toContain(
      'detail_default_unverified'
    )
  })
  it('preserves every list row if a later detail request fails and never exposes the raw error', async () => {
    const h = collectorFixture()
    h.fetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(envelope(1, 1, lazyContent() + lazyContent({ aprno: 'SYNTH-002' })))
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(detailEnvelope())))
      .mockRejectedValueOnce(new Error('private remote credentials'))
    const result = await collectLotteApi(h.current, RANGE)
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0].needsReview).toEqual([])
    expect(result.rows[1].needsReview).toContain('detail_collection_unavailable')
    expect(result.receipt.approvalComplete).toBe(false)
    expect(result.receipt.issues).toContain('detail_collection_unavailable')
    expect(JSON.stringify(result.receipt)).not.toContain('private')
  })
  it('does not treat a login page or malformed P103 Content as transaction details', async () => {
    const h = collectorFixture([
      envelope(1, 1, lazyContent()),
      response('<form><input name="password"></form>')
    ])
    const result = await collectLotteApi(h.current, RANGE)
    expect(result.rows[0].needsReview).toContain('detail_response_schema_unverified')
    expect(result.rows[0].needsReview).toContain('details_unverified')
  })
  it('accepts the official business UL with one auxiliary DIV without reading its values or labels', async () => {
    const html = (detailEnvelope() as { Content: string }).Content
    const extra =
      '<div><input value="private-unused"><p>승인번호 OTHER-SYNTH 취소여부 취소</p><script>throw Error("never executed")</script></div>'
    const h = collectorFixture([envelope(1, 1, lazyContent()), response(html + extra)])
    const result = await collectLotteApi(h.current, RANGE)
    expect(result.rows[0]).toMatchObject({
      approvalNumber: 'SYNTH-001',
      needsReview: [],
      status: 'approved'
    })
    expect(JSON.stringify(result)).not.toMatch(/private-unused|OTHER-SYNTH|never executed/)
  })
  it('rejects a second business list or unrelated top-level script/form rather than guessing a detail root', async () => {
    const html = (detailEnvelope() as { Content: string }).Content
    for (const extra of [
      '<div><ul><li>synthetic</li></ul></div>',
      '<ul></ul>',
      '<form></form>',
      '<script>neverRead()</script>'
    ]) {
      const result = await collectLotteApi(
        collectorFixture([envelope(1, 1, lazyContent()), response(html + extra)]).current,
        RANGE
      )
      expect(result.rows[0].needsReview).toContain('detail_response_schema_unverified')
      expect(result.rows[0].approvalNumber).toBeUndefined()
    }
  })
  it('reports only fixed known cancellation label codes while keeping unverified meanings for review', async () => {
    for (const [label, expected] of [
      ['N', 'cancellation_label_2'],
      ['unknown-private-label', 'cancellation_label_unrecognized']
    ]) {
      const html = (detailEnvelope() as { Content: string }).Content.replace(
        '<span>정상</span>',
        `<span>${label}</span>`
      )
      const result = await collectLotteApi(
        collectorFixture([envelope(1, 1, lazyContent()), response(html)]).current,
        RANGE
      )
      expect(result.receipt.issues).toContain(expected)
      expect(result.rows[0].needsReview).toContain('status_unverified')
      expect(JSON.stringify(result.receipt)).not.toContain('unknown-private-label')
    }
  })
  it('collects every confirmed page with exact date/all-card/all-type filters without mutating the website', async () => {
    const h = collectorFixture([envelope(1, 2), envelope(2, 2, content({ approval: 'SYNTH-002' }))])
    const before = h.dom.window.document.body.innerHTML
    const result = await collectLotteApi(h.current, RANGE)
    expect(result.rows).toHaveLength(2)
    expect(result.receipt).toMatchObject({
      pages: 2,
      rowCount: 2,
      complete: false,
      approvalComplete: true,
      issues: ['cancellation_query_basis_unverified']
    })
    for (const [index, call] of h.fetch.mock.calls.entries()) {
      expect(call[0]).toBe('https://www.lottecard.co.kr/app/LPMCDAA_A102.lc')
      const body = new URLSearchParams(call[1].body)
      expect(Object.fromEntries(body)).toEqual({
        ...FORM,
        encCdno: '',
        startDt: '20260929',
        endDt: '20261002',
        pageNo: String(index + 1),
        nextKey: '',
        sortDv: '0',
        useCdDv: 'A_useCdDv',
        uplDv: 'A_uplDv',
        useDv: 'A_useDv',
        stDv: 'A_stDv'
      })
    }
    expect(h.dom.window.document.body.innerHTML).toBe(before)
    expect(JSON.stringify(result.receipt)).not.toMatch(/private-|SYNTH|합성|1234|A_use/)
  })
  it('stages incomplete-detail and unsupported rows for review while proving all-page coverage separately', async () => {
    const h = collectorFixture([
      envelope(1, 1, content({ details: false }).replaceAll('일시불', '단기카드대출'))
    ])
    const result = await collectLotteApi(h.current, RANGE)
    expect(result.rows).toHaveLength(1)
    expect(result.receipt.approvalComplete).toBe(true)
    expect(result.receipt.issues).toEqual(
      expect.arrayContaining([
        'details_unverified',
        'identity_unverified',
        'transaction_type_unverified'
      ])
    )
    expect(result.rows[0].needsReview.length).toBeGreaterThan(0)
  })
  it('requires both explicit zero total pages and a recognized empty root for empty coverage', async () => {
    const full = '<ul id="useCardList" class="useCardList type02"></ul>'
    const confirmed = await collectLotteApi(collectorFixture([envelope(1, 0, full)]).current, RANGE)
    expect(confirmed.receipt.approvalComplete).toBe(true)
    for (const value of [envelope(1, 0, ''), envelope(1, 1, full), envelope(1, 0)]) {
      const result = await collectLotteApi(collectorFixture([value]).current, RANGE)
      expect(result.receipt.approvalComplete).toBe(false)
      expect(result.rows).toEqual([])
    }
  })
  it('accepts the confirmed empty marker only with the exact terminal page-one contract', async () => {
    const html = '<li class="noData">조회하신 조건에 맞는 내역이 없습니다.</li>'
    const good = await collectLotteApi(
      collectorFixture([envelope(1, 1, html, { nextPageNo: 1 })]).current,
      RANGE
    )
    expect(good.rows).toEqual([])
    expect(good.receipt).toMatchObject({
      approvalComplete: true,
      pages: 1,
      rowCount: 0,
      complete: false
    })
    for (const value of [
      envelope(1, 1, html, { nextPageNo: 2 }),
      envelope(1, 2, html, { nextPageNo: 1 })
    ]) {
      const result = await collectLotteApi(collectorFixture([value]).current, RANGE)
      expect(result.receipt.approvalComplete).toBe(false)
      expect(result.receipt.issues).toContain('page_count_mismatch')
    }
  })
  it.each([
    { name: 'repeated page', second: envelope(1, 2), issue: 'pagination_unverified' },
    { name: 'changing total', second: envelope(2, 3), issue: 'pagination_changed' },
    {
      name: 'wrong date echo',
      second: envelope(2, 2, content(), { startDt: '20260101' }),
      issue: 'response_scope_mismatch'
    },
    {
      name: 'wrong card echo',
      second: envelope(2, 2, content(), { encCdno: 'private-unrelated' }),
      issue: 'response_scope_mismatch'
    },
    { name: 'missing Param', second: response(), issue: 'pagination_unverified' }
  ])('preserves verified earlier rows on $name', async ({ second, issue }) => {
    const result = await collectLotteApi(collectorFixture([envelope(1, 2), second]).current, RANGE)
    expect(result.rows).toHaveLength(1)
    expect(result.receipt.approvalComplete).toBe(false)
    expect(result.receipt.issues).toContain(issue)
  })
  it('stops on missing/non-advancing next page and the caller page limit', async () => {
    for (const nextPageNo of [1, undefined]) {
      const h = collectorFixture([envelope(1, 2, content(), { nextPageNo })])
      const result = await collectLotteApi(h.current, RANGE)
      expect(result.rows).toHaveLength(1)
      expect(result.receipt.issues).toContain('pagination_not_advancing')
      expect(h.fetch).toHaveBeenCalledTimes(1)
    }
    const h = collectorFixture([envelope(1, 2)])
    const result = await collectLotteApi(h.current, RANGE, { maxPages: 1 })
    expect(result.rows).toHaveLength(1)
    expect(result.receipt.approvalComplete).toBe(false)
    expect(result.receipt.issues).toContain('page_limit')
  })
  it('retains duplicate identities for review and refuses complete approval coverage', async () => {
    const result = await collectLotteApi(
      collectorFixture([envelope(1, 2), envelope(2, 2)]).current,
      RANGE
    )
    expect(result.rows).toHaveLength(2)
    expect(result.rows.every((row) => row.needsReview.includes('duplicate_source_identity'))).toBe(
      true
    )
    expect(result.receipt.approvalComplete).toBe(false)
  })
  it('retains an outside-range row for review but accepts an in-range cancellation event', async () => {
    const html = content().replaceAll('2026.10.02', '2026.09.28')
    const result = await collectLotteApi(collectorFixture([envelope(1, 1, html)]).current, RANGE)
    expect(result.rows[0].needsReview).toContain('outside_requested_range')
    expect(result.receipt.approvalComplete).toBe(false)
    const cancel = content({ kind: 'cancelled', cancelDate: '2026.10.02' })
      .replaceAll('2026.10.02', '2026.09.28')
      .replace(
        '취소일자<input value="not-a-business-value"><span>2026.09.28</span>',
        '취소일자<input value="not-a-business-value"><span>2026.10.02</span>'
      )
    const kept = await collectLotteApi(collectorFixture([envelope(1, 1, cancel)]).current, RANGE)
    expect(kept.receipt.approvalComplete).toBe(true)
    expect(kept.rows[0].needsReview).toContain('cancellation_query_basis_unverified')
  })
  it('does not send queries if the exact form or unique all-option semantics cannot be proven', async () => {
    for (const mutate of [
      (doc: Document): void => {
        doc.querySelector('form')!.remove()
      },
      (doc: Document): void => {
        doc.querySelector('input[name="useDvRadio"]')!.parentElement!.lastChild!.textContent =
          '일시불'
      },
      (doc: Document): void => {
        doc.body.append(
          doc.querySelector('input[name="useDvRadio"]')!.parentElement!.cloneNode(true)
        )
      },
      (doc: Document): void => {
        ;(doc.querySelector('input[name="pageRows"]') as HTMLInputElement).value = '1001'
      }
    ]) {
      const h = collectorFixture()
      mutate(h.dom.window.document)
      const result = await collectLotteApi(h.current, RANGE)
      expect(result.receipt.issues).toContain('request_schema_unverified')
      expect(h.fetch).not.toHaveBeenCalled()
    }
  })
  it('rejects a changed private scope even on the final page', async () => {
    const h = collectorFixture()
    h.fetch.mockImplementationOnce(async () => {
      ;(h.dom.window.document.querySelector('input[name="encCdno"]') as HTMLInputElement).value =
        'private-changed'
      return new Response(JSON.stringify(envelope()))
    })
    const result = await collectLotteApi(h.current, RANGE)
    expect(result.rows).toEqual([])
    expect(result.receipt.issues).toContain('query_scope_changed')
  })
  it('preserves earlier rows and sanitizes a later fetch failure', async () => {
    const h = collectorFixture([envelope(1, 2)])
    h.fetch
      .mockImplementationOnce(async () => new Response(JSON.stringify(envelope(1, 2))))
      .mockRejectedValueOnce(new Error('private server details'))
    const result = await collectLotteApi(h.current, RANGE)
    expect(result.rows).toHaveLength(1)
    expect(result.receipt.approvalComplete).toBe(false)
    expect(result.receipt.issues).toContain('collection_unavailable')
    expect(JSON.stringify(result.receipt)).not.toContain('private')
  })
  it('stops before posting when authentication expires or navigation changes during planning', async () => {
    const h = collectorFixture()
    auth
      .mockResolvedValueOnce({ issuer: 'lotte_card', state: 'signed_in' })
      .mockResolvedValue({ issuer: 'lotte_card', state: 'signed_out' })
    const expired = await collectLotteApi(h.current, RANGE)
    expect(expired.receipt.issues).toContain('authentication_required')
    expect(h.fetch).not.toHaveBeenCalled()
    auth.mockResolvedValue({ issuer: 'lotte_card', state: 'signed_in' })
    const second = collectorFixture()
    second.execute.mockImplementationOnce(async (script) => {
      second.navigate()
      return second.dom.window.eval(script)
    })
    const moved = await collectLotteApi(second.current, RANGE)
    expect(moved.receipt.issues).toContain('navigation_changed')
    expect(second.fetch).not.toHaveBeenCalled()
  })
  it('bounds a hanging private form read and respects cancellation without requesting the server', async () => {
    vi.useFakeTimers()
    const h = collectorFixture()
    h.execute.mockImplementationOnce(() => new Promise(() => {}))
    const pending = collectLotteApi(h.current, RANGE)
    await vi.advanceTimersByTimeAsync(20001)
    const result = await pending
    expect(result.receipt.issues).toContain('request_timeout')
    expect(h.fetch).not.toHaveBeenCalled()
    const second = collectorFixture()
    second.execute.mockImplementationOnce(() => new Promise(() => {}))
    const controller = new AbortController()
    const cancelled = collectLotteApi(second.current, RANGE, { signal: controller.signal })
    await vi.advanceTimersByTimeAsync(1)
    controller.abort()
    expect((await cancelled).receipt.issues).toContain('cancelled')
    expect(second.fetch).not.toHaveBeenCalled()
  })
  it('refuses a different origin/path, unauthenticated session, invalid range, or prior cancellation', async () => {
    const range = { from: '2026-09-29', to: '2026-10-02' }
    for (const url of [
      'https://www.lottecard.co.kr.evil.test/app/LPMCDAA_V100.lc',
      'https://www.lottecard.co.kr/app/LPMANAA_V200.lc'
    ]) {
      expect((await collectLotteApi(tab(url), range)).receipt.issues).toContain(
        'history_page_required'
      )
    }
    auth.mockResolvedValue({ issuer: 'lotte_card', state: 'signed_out' })
    expect((await collectLotteApi(tab(), range)).receipt.issues).toContain(
      'authentication_required'
    )
    expect(
      (await collectLotteApi(tab(), { from: '2026-02-30', to: range.to })).receipt.issues
    ).toContain('invalid_range')
    expect(
      (await collectLotteApi(tab(), { from: '2026-09-28', to: range.to })).receipt.issues
    ).toContain('invalid_range')
    expect(
      (await collectLotteApi(tab(), range, { signal: AbortSignal.abort() })).receipt.issues
    ).toContain('cancelled')
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
    await expect(requestLotteApiPage(h.current, form)).rejects.toThrow('lotte_navigation_changed')
    const second = transportFixture()
    auth
      .mockResolvedValueOnce({ issuer: 'lotte_card', state: 'signed_in' })
      .mockResolvedValueOnce({ issuer: 'lotte_card', state: 'signed_out' })
    await expect(requestLotteApiPage(second.current, form)).rejects.toThrow(
      'lotte_authentication_required'
    )
  })
  it('bounds response bytes and keeps malformed body errors fixed', async () => {
    auth.mockResolvedValue({ issuer: 'lotte_card', state: 'signed_in' })
    for (const [body, expected] of [
      ['x'.repeat(2 * 1024 * 1024 + 1), 'lotte_response_limit'],
      ['private malformed response', 'lotte_request_unavailable']
    ]) {
      const h = transportFixture()
      h.fetch.mockResolvedValueOnce(new Response(body))
      await expect(requestLotteApiPage(h.current, form)).rejects.toThrow(expected)
    }
  })
})
