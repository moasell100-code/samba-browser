import { webcrypto } from 'node:crypto'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../src/main/browser/tab-manager'
import { pageBridge } from '../src/main/browser/page-bridge'
import { collectSamsungApi } from '../src/main/finance/samsung-api-collector'

const URL = 'https://www.samsungcard.com/personal/card/activity/UHPPRP0801M0.jsp'
const RANGE = { from: '2026-09-29', to: '2026-10-02' }
const windows: JSDOM[] = []
type Query = {
  service: string
  data: Record<string, unknown>
  success: (response: unknown) => void
  error: () => void
}
type SourceRow = Record<string, string | number | null>

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const dom of windows.splice(0)) dom.window.close()
})

function row(index = 1, overrides: SourceRow = {}): SourceRow {
  return {
    aprDt: '20261002',
    aprT: '091213',
    aprno: String(index).padStart(8, '0'),
    aprAm: '12,300',
    mrcNm: '합성 가맹점',
    itgCdnoe: '0000000000004321',
    canRcpdt: '',
    poCanDvC: '',
    canProcsStsC: '',
    ...overrides
  }
}

function response(
  service: string,
  rows: SourceRow[] = [],
  total = rows.length,
  cursor = ''
): object {
  return {
    common: { procsRsDvC: '0', privateCommon: 'PRIVATE_ENVELOPE' },
    totDlngCt: String(total),
    [service.endsWith('S51') ? 'hppRPCardUIzSub01SVO' : 'hppRPDomCanIzSub01SVO']: rows,
    ...Object.fromEntries(
      Array.from({ length: service.endsWith('S51') ? 9 : 7 }, (_, i) => [
        `no${i + 1}NextKeyCn`,
        cursor ? `${cursor}_${i + 1}` : ''
      ])
    ),
    privateResponse: 'UNREQUESTED_FIELD'
  }
}

function fixture(handler?: (query: Query, index: number) => void): {
  tab: Tab
  dom: JSDOM
  calls: Query[]
  execute: ReturnType<typeof vi.fn>
  condition: Record<string, unknown>
  setUrl: (url: string) => void
  auth: ReturnType<typeof vi.spyOn<typeof pageBridge, 'cardSession'>>
} {
  let current = URL
  const dom = new JSDOM('<input id="start_day" value="2026.01.01">', {
    url: URL,
    runScripts: 'outside-only'
  })
  windows.push(dom)
  Object.defineProperty(dom.window.crypto, 'subtle', { value: webcrypto.subtle })
  Object.assign(dom.window, { TextEncoder })
  const condition: Record<string, unknown> = {
    cardDvC: '1',
    cardKndC: '01',
    isCstMngtNo: 'SYNTHETIC_SCOPE',
    pssCstMngtNo: 0,
    cardCntrNo: 0,
    strtAm: 50000,
    endAm: 60000,
    inqrStrtdt: '20260101',
    unrequestedSecret: 'UNREQUESTED_CONDITION'
  }
  const calls: Query[] = []
  Object.assign(dom.window, {
    ENV: { CONDITION: condition },
    scard: {
      ajax(query: Query) {
        calls.push(query)
        if (handler) handler(query, calls.length)
        else query.success(response(query.service, query.service.endsWith('S51') ? [row()] : []))
      }
    }
  })
  const execute = vi.fn((script: string, userGesture: boolean) => {
    expect(userGesture).toBe(false)
    return dom.window.eval(script)
  })
  const tab = {
    view: {
      webContents: {
        getURL: () => current,
        isDestroyed: () => false,
        executeJavaScript: execute
      }
    }
  } as unknown as Tab
  const auth = vi
    .spyOn(pageBridge, 'cardSession')
    .mockResolvedValue({ issuer: 'samsung_card', state: 'signed_in' })
  return { tab, dom, calls, execute, condition, setUrl: (url) => (current = url), auth }
}

describe('Samsung fixed private statement API collector', () => {
  it('uses only S51/S12 and exact four-day filters, without changing page state or exporting full card data', async () => {
    const f = fixture()
    const before = JSON.stringify(f.condition)
    const result = await collectSamsungApi(f.tab, RANGE)
    expect(f.calls.map((call) => call.service)).toEqual(['SHPPRP0801S51', 'SHPPRP0801S12'])
    expect(f.calls[0].data).toEqual({
      cardDvC: '1',
      cardKndC: '01',
      isCstMngtNo: 'SYNTHETIC_SCOPE',
      pssCstMngtNo: 0,
      cardCntrNo: 0,
      inqrStrtdt: '20260929',
      inqrEnddt: '20261002',
      no1PgeSize: 10,
      ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`no${i + 1}NextKeyCn`, ''])),
      strtAm: -99999999999,
      endAm: 99999999999,
      dtAry: '',
      amAry: '',
      cardUIzInqrDvC: 'Z',
      fpyIstmIz: { cardUMthDvC: '00', fpyIstmDvC: ' ' }
    })
    expect(f.calls[1].data).toMatchObject({
      canDvC: '',
      cardUIzInqrDvC: 'H',
      domCanIz: { cardUMthDvC: '00', canDvC: '' }
    })
    expect(f.calls[1].data).not.toHaveProperty('no8NextKeyCn')
    expect(f.calls[1].data).not.toHaveProperty('strtAm')
    expect(JSON.stringify(f.condition)).toBe(before)
    expect(f.dom.window.document.querySelector('input')?.value).toBe('2026.01.01')
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      issuer: 'samsung_card',
      approvedAt: '2026-10-02T09:12:13+09:00',
      cardLast4: '4321',
      approvalNumber: '00000001',
      amount: 12300,
      netAmount: 12300,
      status: 'approved',
      kind: 'approval',
      needsReview: []
    })
    expect(result.rows[0].sourceId).toMatch(/^samsung_card:[a-f0-9]{64}$/)
    expect(result.receipt).toMatchObject({
      pages: 2,
      rowCount: 1,
      complete: false,
      approvalComplete: true,
      issues: ['cancellation_query_basis_unverified']
    })
    for (const secret of ['0000000000004321', 'PRIVATE_ENVELOPE', 'UNREQUESTED_FIELD']) {
      expect(JSON.stringify(result)).not.toContain(secret)
    }
    for (const privateValue of ['합성 가맹점', '00000001', '4321', '12300', 'SYNTHETIC_SCOPE']) {
      expect(JSON.stringify(result.receipt)).not.toContain(privateValue)
    }
    expect(f.auth).toHaveBeenCalledTimes(4)
  })

  it('paginates all nine approval and seven cancellation cursors without mutating ENV', async () => {
    const f = fixture((query) => {
      const approval = query.service.endsWith('S51')
      const page = Number(query.data.pgeNo || 1)
      const total = approval ? 21 : 11
      const start = (page - 1) * 10
      const rows = Array.from({ length: Math.min(10, total - start) }, (_, i) =>
        row(start + i + 1, approval ? {} : { canRcpdt: '20261002', canProcsStsC: '1' })
      )
      query.success(response(query.service, rows, total, `PAGE_${page}`))
    })
    const result = await collectSamsungApi(f.tab, RANGE)
    expect(result.rows).toHaveLength(32)
    expect(result.receipt.pages).toBe(5)
    expect(f.calls.map((call) => call.data.pgeNo ?? 1)).toEqual([1, 2, 3, 1, 2])
    expect(f.calls[1].data.no9NextKeyCn).toBe('PAGE_1_9')
    expect(f.calls[4].data.no7NextKeyCn).toBe('PAGE_1_7')
    expect(f.calls[4].data).not.toHaveProperty('no8NextKeyCn')
    expect(f.calls[1].data.prtgPrvwYn).toBe('')
    expect(f.condition).not.toHaveProperty('pgeNo')
    expect(new Set(result.rows.map((item) => item.sourceId)).size).toBe(32)
    expect(result.receipt.issues).not.toContain('total_count_mismatch')
    expect(result.receipt.approvalComplete).toBe(true)
  })

  it('retains verified approval coverage when the separate cancellation service fails', async () => {
    const f = fixture((query) => {
      if (query.service.endsWith('S12')) query.error()
      else query.success(response(query.service, [row()]))
    })
    const result = await collectSamsungApi(f.tab, RANGE)
    expect(result.receipt).toMatchObject({ complete: false, approvalComplete: true })
    expect(result.receipt.issues).toContain('service_error')
    expect(result.rows[0].needsReview).toEqual([])
  })

  it('retains row-level review without claiming those rows are safe to post', async () => {
    const f = fixture((query) =>
      query.success(
        response(
          query.service,
          query.service.endsWith('S51') ? [row(1), row(2, { itgCdnoe: '' })] : []
        )
      )
    )
    const result = await collectSamsungApi(f.tab, RANGE)
    expect(result.receipt).toMatchObject({ complete: false, approvalComplete: true })
    expect(result.rows[0].needsReview).toEqual([])
    expect(result.rows[1].needsReview).toContain('card_last4_unavailable')
  })

  it.each([
    { identity: '123456789012345', flags: ['card_number_length_15', 'card_tail_digits_available'] },
    {
      identity: '1234-5678-9012-3456',
      flags: ['card_number_length_19', 'card_tail_digits_available']
    },
    { identity: '12345678********', flags: ['card_number_length_16', 'card_tail_masked'] },
    {
      identity: '            1234',
      flags: [
        'card_number_length_16',
        'card_tail_digits_available',
        'card_official_tail_digits_available',
        'card_last4_shift_after_trim'
      ]
    },
    { identity: 'SYNTHETIC_OPAQUE_TOKEN', flags: ['card_number_length_other'] },
    { identity: null, flags: ['card_identity_not_string'] }
  ])(
    'reports only fixed card-shape diagnostics without guessing missing suffixes (%#)',
    async ({ identity, flags }) => {
      const f = fixture((query) =>
        query.success(
          response(
            query.service,
            query.service.endsWith('S51') ? [row(1, { itgCdnoe: identity })] : []
          )
        )
      )
      const result = await collectSamsungApi(f.tab, RANGE)
      expect(result.rows[0].cardLast4).toBeUndefined()
      expect(result.rows[0].needsReview).toEqual(
        expect.arrayContaining(['card_last4_unavailable', ...flags])
      )
      expect(result.receipt.issues).toEqual(expect.arrayContaining(flags))
      expect(result.receipt.approvalComplete).toBe(true)
      if (identity) expect(JSON.stringify(result.receipt)).not.toContain(identity)
      expect(JSON.stringify(result.receipt)).not.toContain('00000001')
      expect(result.receipt).not.toHaveProperty('identityDiagnostics')
    }
  )

  it('does not add shape diagnostics to normal verified suffix rows', async () => {
    const f = fixture()
    const result = await collectSamsungApi(f.tab, RANGE)
    expect(result.rows[0].cardLast4).toBe('4321')
    expect(result.rows[0].needsReview).toEqual([])
    expect(result.receipt.issues.filter((issue) => issue.startsWith('card_'))).toEqual([])
  })

  it.each(['invalid_row', 'outside_range', 'duplicate', 'short_page'] as const)(
    'does not certify approval coverage with %s',
    async (fault) => {
      const f = fixture((query) => {
        let rows = [row()]
        if (fault === 'invalid_row') rows = [row(1, { aprDt: 'bad-date' })]
        if (fault === 'outside_range') rows = [row(1, { aprDt: '20260901' })]
        if (fault === 'duplicate') rows = [row(), row()]
        query.success(
          response(
            query.service,
            query.service.endsWith('S51') ? rows : [],
            query.service.endsWith('S51') ? (fault === 'short_page' ? 11 : rows.length) : 0
          )
        )
      })
      const result = await collectSamsungApi(f.tab, RANGE)
      expect(result.receipt.approvalComplete).toBe(false)
      expect(result.receipt.complete).toBe(false)
    }
  )

  it('revokes approval proof if the account session changes before completion', async () => {
    const f = fixture()
    f.auth
      .mockResolvedValueOnce({ issuer: 'samsung_card', state: 'signed_in' })
      .mockResolvedValueOnce({ issuer: 'samsung_card', state: 'signed_in' })
      .mockResolvedValueOnce({ issuer: 'samsung_card', state: 'signed_out' })
    const result = await collectSamsungApi(f.tab, RANGE)
    expect(result.rows).toHaveLength(1)
    expect(result.receipt).toMatchObject({ complete: false, approvalComplete: false })
    expect(result.receipt.issues).toContain('signed_out')
  })

  it('never treats partial or pending cancellation original amounts as actual refunds', async () => {
    const f = fixture((query) => {
      query.success(
        response(
          query.service,
          query.service.endsWith('S51')
            ? [row(1, { aprAm: -500, poCanDvC: '1', canRcpdt: '20261002' })]
            : [
                row(1, {
                  aprAm: 12300,
                  canRcpdt: '20261002',
                  canProcsStsC: '2',
                  poCanDvC: '2'
                }),
                row(2, { canProcsStsC: '3', canRcpdt: '20261002' })
              ]
        )
      )
    })
    const result = await collectSamsungApi(f.tab, RANGE)
    expect(result.rows.map((item) => item.status)).toEqual([
      'partially_cancelled',
      'partially_cancelled',
      'unknown'
    ])
    expect(result.rows.map((item) => item.amount)).toEqual([500, 12300, 12300])
    expect(
      result.rows.every((item) => item.cancellationAmount === null && item.netAmount === null)
    ).toBe(true)
    expect(result.rows[0].needsReview).toContain('amount_basis_unverified')
    expect(result.rows[2].needsReview).toContain('cancellation_pending')
    expect(result.rows[0].sourceId).not.toBe(result.rows[1].sourceId)
  })

  it('keeps approval IDs stable when amounts or merchant labels change', async () => {
    let revised = false
    const f = fixture((query) => {
      query.success(
        response(
          query.service,
          query.service.endsWith('S51')
            ? [row(1, revised ? { aprAm: 23400, mrcNm: '수정 상호' } : {})]
            : []
        )
      )
    })
    const first = await collectSamsungApi(f.tab, RANGE)
    revised = true
    const second = await collectSamsungApi(f.tab, RANGE)
    expect(first.rows[0].sourceId).toBe(second.rows[0].sourceId)
  })

  it('does not collide an approval with an S51 cancellation whose event date is missing', async () => {
    const f = fixture((query) => {
      query.success(
        response(
          query.service,
          query.service.endsWith('S51') ? [row(), row(1, { aprAm: -500 })] : []
        )
      )
    })
    const result = await collectSamsungApi(f.tab, RANGE)
    expect(result.rows[0].sourceId).not.toBe(result.rows[1].sourceId)
    expect(result.rows[1].needsReview).toContain('cancellation_event_date_unavailable')
  })

  it.each([
    { from: '2026-09-28', to: '2026-10-02' },
    { from: '2026-10-03', to: '2026-10-02' },
    { from: '2026-02-30', to: '2026-03-01' },
    { from: "20261002');fetch('https://evil.test')//", to: '20261002' }
  ])('rejects invalid or expanded date ranges before page access: %j', async (range) => {
    const f = fixture()
    const result = await collectSamsungApi(f.tab, range)
    expect(result.receipt.issues).toEqual(['invalid_date_range'])
    expect(f.auth).not.toHaveBeenCalled()
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('normalizes compact dates and handles true empty statement responses', async () => {
    const f = fixture((query) => {
      const data = response(query.service) as Record<string, unknown>
      data[query.service.endsWith('S51') ? 'hppRPCardUIzSub01SVO' : 'hppRPDomCanIzSub01SVO'] = null
      query.success(data)
    })
    const result = await collectSamsungApi(f.tab, { from: '20261001', to: '20261002' })
    expect(result.receipt.range).toEqual({ from: '2026-10-01', to: '2026-10-02' })
    expect(result.rows).toEqual([])
    expect(result.receipt.pages).toBe(2)
  })

  it('requires the exact history origin/path and an authenticated Samsung session', async () => {
    const f = fixture()
    f.setUrl('https://www.samsungcard.com.evil.test/personal/card/activity/UHPPRP0801M0.jsp')
    expect((await collectSamsungApi(f.tab, RANGE)).receipt.issues).toEqual(['not_history_page'])
    f.setUrl(URL)
    f.auth.mockResolvedValue({ issuer: 'samsung_card', state: 'signed_out' })
    expect((await collectSamsungApi(f.tab, RANGE)).receipt.issues).toEqual(['signed_out'])
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('refuses a selected individual card and does not silently expand its scope', async () => {
    const f = fixture()
    f.condition.cardCntrNo = 'INDIVIDUAL_SYNTHETIC_CARD'
    const result = await collectSamsungApi(f.tab, RANGE)
    expect(result.receipt.issues).toEqual(['card_scope_not_all'])
    expect(f.calls).toHaveLength(0)
    expect(f.condition.cardCntrNo).toBe('INDIVIDUAL_SYNTHETIC_CARD')
  })

  it('rejects data if navigation or authentication changes while a request is in flight', async () => {
    const f = fixture((query) => {
      f.setUrl('https://www.samsungcard.com/personal/login/UHPPCO0301M0.jsp')
      query.success(response(query.service, [row()]))
    })
    const result = await collectSamsungApi(f.tab, RANGE)
    expect(result.receipt.issues).toEqual(['navigation_changed'])
    expect(result.rows).toEqual([])
    expect(f.calls).toHaveLength(1)
  })

  it('stops when the all-card customer scope changes between pages', async () => {
    const f = fixture((query, index) => {
      const rows = Array.from({ length: index === 1 ? 10 : 1 }, (_, i) => row(index * 10 + i))
      query.success(response(query.service, rows, 11, 'NEXT'))
      if (index === 1) f.condition.isCstMngtNo = 'OTHER_SYNTHETIC_SCOPE'
    })
    const result = await collectSamsungApi(f.tab, RANGE)
    expect(result.receipt.issues).toContain('card_scope_changed')
    expect(result.rows).toHaveLength(10)
  })

  it.each([
    'missing_pagination_cursor',
    'pagination_stalled',
    'total_count_mismatch',
    'total_changed'
  ])('reports %s without claiming completion', async (failure) => {
    const f = fixture((query, index) => {
      const count = failure === 'total_count_mismatch' ? 1 : 10
      const total = failure === 'total_changed' && index > 1 ? 31 : 30
      query.success(
        response(
          query.service,
          Array.from({ length: count }, (_, i) => row(index * 10 + i)),
          total,
          failure === 'missing_pagination_cursor' ? '' : 'UNCHANGED'
        )
      )
    })
    const result = await collectSamsungApi(f.tab, RANGE)
    expect(result.receipt.issues).toContain(failure)
    expect(result.receipt.complete).toBe(false)
    expect(f.calls.length).toBeLessThanOrEqual(2)
  })

  it('bounds pages and rejects business errors without returning raw error payloads', async () => {
    const f = fixture((query) => {
      query.success(
        response(
          query.service,
          Array.from({ length: 10 }, (_, i) => row(i)),
          11,
          'NEXT'
        )
      )
    })
    const limited = await collectSamsungApi(f.tab, RANGE, { maxPages: 1 })
    expect(limited.receipt.issues).toEqual(['page_limit'])
    expect(limited.rows).toHaveLength(10)
    Object.assign(f.dom.window, {
      scard: {
        ajax(query: Query) {
          query.success({ common: { procsRsDvC: '8' }, message: 'PRIVATE_SERVICE_ERROR' })
        }
      }
    })
    const failed = await collectSamsungApi(f.tab, RANGE)
    expect(failed.receipt.issues).toEqual(['service_error'])
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_SERVICE_ERROR')
  })

  it('rejects malformed or out-of-range approval rows and preserves duplicate uncertainty', async () => {
    const f = fixture((query) => {
      query.success(
        response(
          query.service,
          query.service.endsWith('S51')
            ? [
                row(),
                row(),
                row(2, { aprAm: '12,30' }),
                row(3, { aprDt: '20261003' }),
                row(4, { aprDt: '20260230' })
              ]
            : []
        )
      )
    })
    const result = await collectSamsungApi(f.tab, RANGE)
    expect(result.rows).toHaveLength(2)
    expect(result.receipt.issues).toEqual(
      expect.arrayContaining([
        'invalid_transaction_row',
        'approval_outside_requested_range',
        'duplicate_source_identity'
      ])
    )
    expect(result.rows[1].needsReview).toContain('duplicate_source_identity')
    expect(result.rows[0].needsReview).toContain('duplicate_source_identity')
  })

  it('stops before access on pre-abort and discards an in-flight result on abort', async () => {
    const preAbort = new AbortController()
    preAbort.abort()
    const f = fixture()
    expect(
      (await collectSamsungApi(f.tab, RANGE, { signal: preAbort.signal })).receipt.issues
    ).toEqual(['aborted'])
    expect(f.execute).not.toHaveBeenCalled()
    const controller = new AbortController()
    Object.assign(f.dom.window, {
      scard: {
        ajax(query: Query) {
          controller.abort()
          query.success(response(query.service, [row()]))
        }
      }
    })
    const result = await collectSamsungApi(f.tab, RANGE, { signal: controller.signal })
    expect(result.rows).toEqual([])
    expect(result.receipt.issues).toEqual(['aborted'])
  })

  it('times out a nonresponding service without retrying or returning partial response text', async () => {
    vi.useFakeTimers()
    const f = fixture(() => undefined)
    const pending = collectSamsungApi(f.tab, RANGE)
    await vi.advanceTimersByTimeAsync(16_100)
    const result = await pending
    expect(result.receipt.issues).toEqual(['request_timeout'])
    expect(result.rows).toEqual([])
    expect(f.calls).toHaveLength(1)
  })
})
