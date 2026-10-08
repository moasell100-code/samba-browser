import { webcrypto } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../src/main/browser/tab-manager'
import { pageBridge } from '../src/main/browser/page-bridge'
import { collectRecentCard } from '../src/main/finance/card-sync'
import * as samsungExport from '../src/main/finance/samsung-excel-export'
import {
  collectSamsungApi,
  collectSamsungCancellationApi,
  probeSamsungCancellationDetails
} from '../src/main/finance/samsung-api-collector'

const URL = 'https://www.samsungcard.com/personal/card/activity/UHPPRP0801M0.jsp'
const RANGE = { from: '2026-09-29', to: '2026-10-02' }
const windows: JSDOM[] = []
const officialCancellationRows = new WeakMap<Tab, SourceRow[]>()
type Query = {
  service: string
  data: Record<string, unknown>
  success: (response: unknown) => void
  error: () => void
}
type SourceRow = Record<string, string | number | null>

beforeEach(() => {
  vi.spyOn(samsungExport, 'exportSamsungWorkbook').mockImplementation(async (tab, range) => {
    const from = range.from.replaceAll('-', '')
    const to = range.to.replaceAll('-', '')
    const expectedRows = (officialCancellationRows.get(tab) ?? []).filter((row) => {
      const day = String(row.aprDt).replaceAll('-', '')
      return from <= day && day <= to
    }).length
    return {
      issuer: 'samsung_card',
      range,
      scope: 'domestic_cancellation',
      service: 'SHPPRP0801S32',
      extension: 'xlsx',
      expectedRows,
      bytes: expectedRows ? Buffer.from('PRIVATE_SYNTHETIC_WORKBOOK') : Buffer.alloc(0)
    }
  })
})

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
    cdnoId: '',
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
    [service.endsWith('S51')
      ? 'hppRPCardUIzSub01SVO'
      : service.endsWith('S13')
        ? 'hppRPFrnCanIzSub01SVO'
        : 'hppRPDomCanIzSub01SVO']: rows,
    ...Object.fromEntries(
      Array.from(
        { length: service.endsWith('S51') ? 9 : service.endsWith('S13') ? 4 : 7 },
        (_, i) => [`no${i + 1}NextKeyCn`, cursor ? `${cursor}_${i + 1}` : '']
      )
    ),
    privateResponse: 'UNREQUESTED_FIELD'
  }
}

function fixture(
  handler?: (query: Query, index: number) => void,
  overseasHandler?: (query: Query, index: number) => void
): {
  tab: Tab
  dom: JSDOM
  calls: Query[]
  execute: ReturnType<typeof vi.fn>
  condition: Record<string, unknown>
  setUrl: (url: string, notify?: boolean) => void
  destroy: () => void
  auth: ReturnType<typeof vi.spyOn<typeof pageBridge, 'cardSession'>>
} {
  let current = URL
  let destroyed = false
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
      decodeXss: (value: string) => value,
      ajax(query: Query) {
        calls.push(query)
        const success = query.success
        query.success = (value) => {
          if (query.service.endsWith('S12') && value && typeof value === 'object') {
            const items = (value as Record<string, unknown>).hppRPDomCanIzSub01SVO
            if (Array.isArray(items)) {
              const existing = query.data.pgeNo ? (officialCancellationRows.get(tab) ?? []) : []
              officialCancellationRows.set(tab, [...existing, ...items])
            }
          }
          success(value)
        }
        if (query.service.endsWith('S13')) {
          if (overseasHandler) overseasHandler(query, calls.length)
          else query.success(response(query.service))
        } else if (handler) handler(query, calls.length)
        else query.success(response(query.service, query.service.endsWith('S51') ? [row()] : []))
      }
    }
  })
  const execute = vi.fn((script: string, userGesture: boolean) => {
    expect(userGesture).toBe(false)
    return dom.window.eval(script)
  })
  const webContents = Object.assign(new EventEmitter(), {
    getURL: () => current,
    isDestroyed: () => destroyed,
    executeJavaScript: execute
  })
  const tab = { view: { webContents } } as unknown as Tab
  const auth = vi
    .spyOn(pageBridge, 'cardSession')
    .mockResolvedValue({ issuer: 'samsung_card', state: 'signed_in' })
  return {
    tab,
    dom,
    calls,
    execute,
    condition,
    setUrl: (url, notify = true) => {
      current = url
      if (notify) webContents.emit('did-start-navigation', {}, url, false, true)
    },
    destroy: () => {
      destroyed = true
      webContents.emit('destroyed')
    },
    auth
  }
}

describe('Samsung original-date cancellation-only collector', () => {
  function paymentPartialFixture(
    amounts = [4000, 8300],
    original = 12300
  ): ReturnType<typeof fixture> {
    return fixture((query) =>
      query.success(
        response(
          query.service,
          query.service.endsWith('S51')
            ? [row(1, { aprAm: original })]
            : amounts.map((amount) =>
                row(1, {
                  aprAm: amount,
                  canRcpdt: '20261002',
                  canProcsStsC: '2',
                  poCanDvC: '2'
                })
              )
        )
      )
    )
  }

  function proofExport(
    expectedRows = 2
  ): ReturnType<typeof vi.spyOn<typeof samsungExport, 'exportSamsungWorkbook'>> {
    return vi.spyOn(samsungExport, 'exportSamsungWorkbook').mockResolvedValue({
      issuer: 'samsung_card',
      range: RANGE,
      scope: 'domestic_cancellation',
      service: 'SHPPRP0801S32',
      extension: 'xlsx',
      expectedRows,
      bytes: Buffer.from('SYNTHETIC_WORKBOOK_PRIVATE_BYTES')
    })
  }

  it('aggregates completed payment refunds without inventing events and leaves proof verification to the backend', async () => {
    const exported = proofExport()
    exported.mockResolvedValueOnce({
      issuer: 'samsung_card',
      range: { from: '2026-09-29', to: '2026-09-30' },
      scope: 'domestic_cancellation',
      service: 'SHPPRP0801S32',
      extension: 'xls',
      expectedRows: 0,
      bytes: Buffer.alloc(0)
    })
    const f = paymentPartialFixture()
    const result = await collectSamsungCancellationApi(f.tab, RANGE)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      amount: 12300,
      cancellationAmount: 12300,
      status: 'cancelled',
      netAmount: 0,
      cancellationAmountType: 'cumulative',
      cancellationEvidence: false,
      needsReview: ['cancellation_workbook_proof_required']
    })
    expect(result.rows[0].cancellationEventId).toBeUndefined()
    expect(result.receipt.cancellationQueryComplete).toBe(true)
    expect(result.receipt.issues).not.toContain('duplicate_source_identity')
    expect(result.receipt.rowCount).toBe(1)
    expect(exported).toHaveBeenCalledTimes(2) // The standalone four-date range spans two months.
    expect(exported.mock.calls.map(([, range]) => range)).toEqual([
      { from: '2026-09-29', to: '2026-09-30' },
      { from: '2026-10-01', to: '2026-10-02' }
    ])
    expect(result.cancellationWorkbooks).toHaveLength(2)
    expect(result.cancellationWorkbooks?.[0]).toEqual({
      range: { from: '2026-09-29', to: '2026-09-30' },
      expectedRows: 0,
      contentBase64: ''
    })
    expect(JSON.stringify(result.receipt)).not.toMatch(/PRIVATE_BYTES|contentBase64|4321|가맹점/)
  })

  it('attaches official same-range workbook bytes privately and keeps repeated equal partial amounts as a cumulative total', async () => {
    const exported = proofExport()
    const f = paymentPartialFixture([4000, 4000])
    const range = { from: '2026-10-02', to: '2026-10-02' }
    const result = await collectSamsungCancellationApi(f.tab, range)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      status: 'partially_cancelled',
      amount: 12300,
      cancellationAmount: 8000,
      netAmount: 4300,
      cancellationEvidence: false
    })
    expect(result.rows[0].cancellationEventId).toBeUndefined()
    expect(result.cancellationWorkbooks).toEqual([
      {
        range,
        expectedRows: 2,
        contentBase64: Buffer.from('SYNTHETIC_WORKBOOK_PRIVATE_BYTES').toString('base64')
      }
    ])
    expect(exported).toHaveBeenCalledWith(f.tab, range, {
      scope: 'domestic_cancellation',
      signal: undefined
    })
    expect(result.receipt.issues).toEqual(['cancellation_workbook_proof_required'])
  })

  it.each([false, true])(
    'covers all four daily scopes when only the middle day has partial refunds (other full cancellation=%s)',
    async (fullCancellation) => {
      const range = { from: '2026-10-01', to: '2026-10-04' }
      const f = fixture((query) => {
        const day = String(query.data.inqrStrtdt)
        let values: SourceRow[] = []
        if (day === '20261002')
          values = query.service.endsWith('S51')
            ? [row()]
            : [4000, 8300].map((amount) =>
                row(1, {
                  aprAm: amount,
                  canRcpdt: '20261002',
                  canProcsStsC: '2',
                  poCanDvC: '2'
                })
              )
        else if (day === '20261003' && fullCancellation)
          values = [
            row(2, {
              aprDt: day,
              aprAm: 1000,
              ...(query.service.endsWith('S51') ? {} : { canRcpdt: day, canProcsStsC: '2' })
            })
          ]
        query.success(response(query.service, values))
      })
      const result = await collectRecentCard({
        tab: f.tab,
        range,
        collect: collectSamsungCancellationApi
      })
      expect(result.cancellationWorkbooks?.map((proof) => proof.range)).toEqual([
        { from: '2026-10-01', to: '2026-10-01' },
        { from: '2026-10-02', to: '2026-10-02' },
        { from: '2026-10-03', to: '2026-10-03' },
        { from: '2026-10-04', to: '2026-10-04' }
      ])
      expect(result.cancellationWorkbooks?.map((proof) => proof.expectedRows)).toEqual([
        0,
        2,
        fullCancellation ? 1 : 0,
        0
      ])
      expect(result.cancellationWorkbooks?.[0].contentBase64).toBe('')
      expect(result.cancellationWorkbooks?.[3].contentBase64).toBe('')
      expect(result.receipt.cancellationQueryComplete).toBe(true)
      expect(
        result.rows.find((value) =>
          value.needsReview.includes('cancellation_workbook_proof_required')
        )
      ).toMatchObject({ cancellationAmount: 12300, amount: 12300, cancellationEvidence: false })
      expect(JSON.stringify(result.receipt)).not.toMatch(/contentBase64|PRIVATE|4321/)
    }
  )

  it('keeps the cumulative identity stable when the refund total changes', async () => {
    proofExport()
    const range = { from: '2026-10-02', to: '2026-10-02' }
    const first = await collectSamsungCancellationApi(
      paymentPartialFixture([2000, 4000]).tab,
      range
    )
    const second = await collectSamsungCancellationApi(
      paymentPartialFixture([4000, 5000]).tab,
      range
    )
    expect(first.rows[0].sourceId).toBe(second.rows[0].sourceId)
    expect(first.rows[0].cancellationAmount).toBe(6000)
    expect(second.rows[0].cancellationAmount).toBe(9000)
    expect(first.rows[0].cancellationEventId).toBeUndefined()
    expect(second.rows[0].cancellationEventId).toBeUndefined()
  })

  it.each(['export_failed', 'unsupported_format', 'count_conflict', 'oversized'])(
    'never certifies a candidate without verified official export evidence: %s',
    async (fault) => {
      const exported = proofExport()
      if (fault === 'export_failed')
        exported.mockRejectedValue(new Error('PRIVATE_PROVIDER_DETAIL'))
      else
        exported.mockResolvedValue({
          issuer: 'samsung_card',
          range: RANGE,
          scope: 'domestic_cancellation',
          service: 'SHPPRP0801S32',
          extension: fault === 'unsupported_format' ? 'xls' : 'xlsx',
          expectedRows: fault === 'count_conflict' ? 3 : 2,
          bytes:
            fault === 'oversized' ? Buffer.alloc(2 * 1024 * 1024 + 1) : Buffer.from('PRIVATE_BYTES')
        })
      const result = await collectSamsungCancellationApi(paymentPartialFixture().tab, {
        from: '2026-10-02',
        to: '2026-10-02'
      })
      expect(result.rows[0].cancellationEvidence).toBe(false)
      expect(result.rows[0].needsReview).toEqual(['cancellation_workbook_proof_required'])
      expect(result.cancellationWorkbooks).toBeUndefined()
      expect(JSON.stringify(result.receipt)).not.toMatch(/PRIVATE/)
      expect(result.receipt.cancellationQueryComplete).toBe(true)
    }
  )

  it('does not aggregate refunds exceeding the uniquely proved original amount', async () => {
    const exported = proofExport()
    const result = await collectSamsungCancellationApi(paymentPartialFixture([8000, 8000]).tab, {
      from: '2026-10-02',
      to: '2026-10-02'
    })
    expect(result.rows).toHaveLength(2)
    expect(result.rows.every((row) => row.cancellationAmount === null)).toBe(true)
    expect(exported).toHaveBeenCalledOnce()
    expect(result.cancellationWorkbooks).toHaveLength(1)
  })

  it('keeps S51 private for verification and emits no new approval rows', async () => {
    const f = fixture()
    const result = await collectSamsungCancellationApi(f.tab, RANGE)
    expect(result.rows).toEqual([])
    expect(result.receipt.issues).toEqual([])
    expect(result.receipt).toMatchObject({
      rowCount: 0,
      pages: 3,
      approvalComplete: false,
      statusComplete: false,
      cancellationComplete: false,
      complete: false,
      cancellationQueryComplete: true,
      cancellationQueryBasis: 'original_approval_date'
    })
    expect(f.calls.map((call) => call.service)).toEqual([
      'SHPPRP0801S51',
      'SHPPRP0801S12',
      'SHPPRP0801S13'
    ])
  })

  it('emits the single S12 late-cancellation snapshot without emitting its duplicate S51 summary', async () => {
    const f = fixture((query) =>
      query.success(
        response(
          query.service,
          query.service.endsWith('S51')
            ? [
                row(1, { aprDt: '20260817' }),
                row(1, { aprDt: '20260817', aprAm: -12300, canRcpdt: '20260906' })
              ]
            : [
                row(1, {
                  aprDt: '20260817',
                  canRcpdt: '20260906',
                  canProcsStsC: '2',
                  poCanDvC: ' '
                })
              ]
        )
      )
    )
    const before = JSON.stringify(f.condition)
    const result = await collectSamsungCancellationApi(f.tab, {
      from: '2026-08-17',
      to: '2026-08-17'
    })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      kind: 'cancellation',
      approvedAt: '2026-08-17T09:12:13+09:00',
      eventDate: '2026-09-06',
      amount: 12300,
      cancellationAmount: 12300,
      cancellationEvidence: true,
      cancellationAmountType: 'cumulative',
      needsReview: []
    })
    expect(result.receipt).toMatchObject({
      rowCount: 1,
      cancellationQueryComplete: true,
      cancellationQueryBasis: 'original_approval_date',
      approvalComplete: false,
      statusComplete: false,
      cancellationComplete: false,
      complete: false
    })
    expect(JSON.stringify(f.condition)).toBe(before)
    expect(JSON.stringify(result.receipt)).not.toMatch(/SYNTH|4321|가맹점|12300/)
  })

  it('retains the official first total across zero-total more pages and recognizes padded blank terminal slots', async () => {
    const padded = (value: object): object =>
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          /^no[1-9]NextKeyCn$/.test(key) ? (item ? `  ${item}  ` : '   ') : item
        ])
      )
    const f = fixture(
      (query) => {
        if (query.service.endsWith('S51')) {
          const page = Number(query.data.pgeNo || 1)
          const rows =
            page === 3
              ? [1, 2].map((index) => row(index, { aprAm: -12300, canRcpdt: '20261002' }))
              : Array.from({ length: 10 }, (_, i) => row((page - 1) * 10 + i + 1))
          query.success(
            padded(
              response(query.service, rows, page === 1 ? 22 : 0, page < 3 ? `CURSOR_${page}` : '')
            )
          )
        } else
          query.success(
            padded(
              response(
                query.service,
                [1, 2].map((index) =>
                  row(index, {
                    canRcpdt: '20261002',
                    canProcsStsC: '1',
                    poCanDvC: ' '
                  })
                )
              )
            )
          )
      },
      (query) => query.success(padded(response(query.service)))
    )
    const result = await collectSamsungCancellationApi(f.tab, RANGE)
    expect(result.rows).toHaveLength(2)
    expect(result.receipt).toMatchObject({
      pages: 5,
      cancellationQueryComplete: true,
      issues: [],
      complete: false,
      cancellationComplete: false
    })
    const approvalCalls = f.calls.filter((call) => call.service.endsWith('S51'))
    expect(approvalCalls.map((call) => call.data.no1NextKeyCn)).toEqual([
      '',
      '  CURSOR_1_1  ',
      '  CURSOR_2_1  '
    ])
    expect(
      result.rows.every(
        (item) => item.cancellationEvidence === true && item.needsReview.length === 0
      )
    ).toBe(true)
  })

  it('does not accept a meaningful remaining domestic cursor merely because the count matches', async () => {
    const f = fixture((query) => query.success(response(query.service, [], 0, 'NONEMPTY_CURSOR')))
    const result = await collectSamsungCancellationApi(f.tab, RANGE)
    expect(result.receipt.cancellationQueryComplete).toBe(false)
    expect(result.receipt.issues).toContain('terminal_cursor_remaining')
    expect(f.calls).toHaveLength(1)
  })

  it('retains a proved single partial snapshot only after the existing S41 and S51 checks', async () => {
    const f = fixture((query) => {
      if (query.service.endsWith('S41')) {
        query.success({
          common: { procsRsDvC: '0' },
          aprAm: '-12300',
          hppRPPoCanIzSub01SVO: [{ aprPoCanDtm: '20261002121544', aprPoCanAm: '-4000' }]
        })
      } else
        query.success(
          response(
            query.service,
            query.service.endsWith('S51')
              ? [row(), row(1, { aprAm: -4000, poCanDvC: '1', canRcpdt: '20261002' })]
              : [
                  row(1, {
                    cdnoId: 'SYNTHETIC_OPAQUE_CARD_ID',
                    poCanDvC: '1',
                    canProcsStsC: '1',
                    canRcpdt: '20261002'
                  })
                ]
          )
        )
    })
    const result = await collectSamsungCancellationApi(f.tab, RANGE)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      status: 'partially_cancelled',
      amount: 12300,
      cancellationAmount: 4000,
      cancellationAmountType: 'cumulative',
      cancellationEvidence: true,
      needsReview: []
    })
    expect(result.receipt).toMatchObject({
      cancellationQueryComplete: true,
      approvalComplete: false,
      statusComplete: false,
      cancellationComplete: false,
      complete: false
    })
    expect(f.calls.map((call) => call.service)).toEqual([
      'SHPPRP0801S51',
      'SHPPRP0801S12',
      'SHPPRP0801S41',
      'SHPPRP0801S13'
    ])
  })

  it.each(['missing_summary', 'wrong_original_amount', 'pending', 'unsupported_partial'])(
    'separates complete canonical query coverage from row financial proof on %s',
    async (fault) => {
      const f = fixture((query) =>
        query.success(
          response(
            query.service,
            query.service.endsWith('S51')
              ? [
                  row(1, { aprAm: fault === 'wrong_original_amount' ? 15000 : 12300 }),
                  ...(fault === 'missing_summary'
                    ? []
                    : [row(1, { aprAm: -12300, canRcpdt: '20261002' })])
                ]
              : [
                  row(1, {
                    canRcpdt: '20261002',
                    canProcsStsC: fault === 'pending' ? '3' : '2',
                    poCanDvC: fault === 'unsupported_partial' ? '2' : ''
                  })
                ]
          )
        )
      )
      const result = await collectSamsungCancellationApi(f.tab, RANGE)
      expect(result.rows).toHaveLength(1)
      expect(result.receipt).toMatchObject({
        cancellationQueryComplete: true,
        approvalComplete: false,
        statusComplete: false,
        cancellationComplete: false,
        complete: false
      })
      if (fault === 'missing_summary') {
        expect(result.rows[0].cancellationEvidence).toBe(true)
        expect(result.rows[0].needsReview).toEqual([])
      } else {
        expect(result.rows[0].cancellationEvidence).not.toBe(true)
        if (fault === 'unsupported_partial') {
          expect(result.rows[0].cancellationAmount).toBe(12300)
          expect(result.rows[0].needsReview).toContain('cancellation_workbook_proof_required')
          expect(result.cancellationWorkbooks).toHaveLength(2)
        } else expect(result.rows[0].cancellationAmount).toBeNull()
        expect(result.rows[0].needsReview.length).toBeGreaterThan(0)
      }
      if (fault === 'wrong_original_amount')
        expect(result.rows[0].needsReview).toContain('cancellation_cross_source_conflict')
    }
  )

  it('completes an empty canonical cancellation query despite unrelated S51 approval markers', async () => {
    const f = fixture((query) =>
      query.success(
        response(
          query.service,
          query.service.endsWith('S51') ? [row(1, { poCanDvC: 'UNRELATED_MARKER' })] : []
        )
      )
    )
    const normal = await collectSamsungApi(f.tab, RANGE)
    expect(normal.receipt.statusComplete).toBe(false)
    const cancellation = await collectSamsungCancellationApi(f.tab, RANGE)
    expect(cancellation.rows).toEqual([])
    expect(cancellation.receipt).toMatchObject({
      cancellationQueryComplete: true,
      statusComplete: false,
      cancellationComplete: false,
      complete: false,
      issues: []
    })
  })

  it('preserves a proved cancellation with complete query coverage when another S51 original has an unmatched marker', async () => {
    const f = fixture((query) =>
      query.success(
        response(
          query.service,
          query.service.endsWith('S51')
            ? [
                row(),
                row(1, { aprAm: -12300, canRcpdt: '20261002' }),
                row(2, { poCanDvC: 'UNRELATED_MARKER' })
              ]
            : [row(1, { canProcsStsC: '1', canRcpdt: '20261002' })]
        )
      )
    )
    const result = await collectSamsungCancellationApi(f.tab, RANGE)
    expect(result.receipt).toMatchObject({
      cancellationQueryComplete: true,
      statusComplete: false,
      cancellationComplete: false,
      complete: false,
      issues: []
    })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      cancellationEvidence: true,
      cancellationAmount: 12300,
      needsReview: []
    })
  })

  it.each([
    { aprno: '' },
    { itgCdnoe: '' },
    { aprT: '' },
    { canRcpdt: '' },
    { canRcpdt: '20261001' },
    { canProcsStsC: null },
    { poCanDvC: null },
    { poCanDvC: '0' },
    { aprAm: 0 }
  ] satisfies SourceRow[])(
    'does not certify canonical query metadata with unavailable or invalid fields %#',
    async (overrides) => {
      const f = fixture((query) =>
        query.success(
          response(
            query.service,
            query.service.endsWith('S51')
              ? []
              : [row(1, { canProcsStsC: '1', canRcpdt: '20261002', ...overrides })]
          )
        )
      )
      const result = await collectSamsungCancellationApi(f.tab, RANGE)
      expect(result.receipt.cancellationQueryComplete).toBe(false)
      expect(result.receipt.complete).toBe(false)
    }
  )

  it('certifies a fully read first-page list while keeping two ambiguous partial observations held', async () => {
    const f = fixture((query) =>
      query.success(
        response(
          query.service,
          query.service.endsWith('S51')
            ? []
            : [
                row(1, { canRcpdt: '20261002', canProcsStsC: '2', poCanDvC: '2', aprAm: 12300 }),
                row(1, { canRcpdt: '20261002', canProcsStsC: '2', poCanDvC: '2', aprAm: 15000 })
              ]
        )
      )
    )
    const result = await collectSamsungCancellationApi(f.tab, RANGE)
    expect(result.receipt).toMatchObject({
      cancellationQueryComplete: true,
      complete: false,
      statusComplete: false,
      cancellationComplete: false
    })
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0].sourceId).toBe(result.rows[1].sourceId)
    for (const item of result.rows) {
      expect(item.cancellationEvidence).not.toBe(true)
      expect(item.cancellationAmount).toBeNull()
      expect(item.needsReview).toContain('duplicate_source_identity')
      expect(item.needsReview).toContain('cancellation_detail_identity_unavailable')
    }
    expect(result.receipt.issues).not.toContain('repeated_cancellation_page_row')
  })

  it('keeps distinct raw partial observations listed across pages without inventing unique refund IDs', async () => {
    const f = fixture((query) =>
      query.success(
        query.service.endsWith('S51')
          ? response(query.service)
          : response(
              query.service,
              query.data.pgeNo
                ? [row(1, { canRcpdt: '20261002', canProcsStsC: '2', poCanDvC: '2', aprAm: 15000 })]
                : Array.from({ length: 10 }, (_, i) =>
                    row(i + 1, { canRcpdt: '20261002', canProcsStsC: '2', poCanDvC: '2' })
                  ),
              query.data.pgeNo ? 0 : 11,
              query.data.pgeNo ? '' : 'NEXT'
            )
      )
    )
    const result = await collectSamsungCancellationApi(f.tab, RANGE)
    expect(result.receipt.cancellationQueryComplete).toBe(true)
    expect(result.rows).toHaveLength(11)
    expect(result.rows[0].sourceId).toBe(result.rows[10].sourceId)
    expect(result.rows[0].needsReview).toContain('duplicate_source_identity')
    expect(result.rows[10].needsReview).toContain('duplicate_source_identity')
    expect(result.rows.every((item) => item.cancellationEvidence !== true)).toBe(true)
  })

  it('rejects repeated canonical rows with reversed property order on another page despite changed cursor and matching total', async () => {
    const repeated = Array.from({ length: 10 }, (_, i) =>
      row(i + 1, { canRcpdt: '20261002', canProcsStsC: '2' })
    )
    const f = fixture((query) =>
      query.success(
        query.service.endsWith('S51')
          ? response(query.service)
          : response(
              query.service,
              query.data.pgeNo
                ? repeated.map((item) => Object.fromEntries(Object.entries(item).reverse()))
                : repeated,
              query.data.pgeNo ? 0 : 20,
              query.data.pgeNo ? '' : 'NEXT'
            )
      )
    )
    const result = await collectSamsungCancellationApi(f.tab, RANGE)
    expect(result.receipt.cancellationQueryComplete).toBe(false)
    expect(result.receipt.issues).toContain('repeated_cancellation_page_row')
    expect(
      result.rows.every(
        (item) => item.cancellationEvidence !== true && item.cancellationAmount === null
      )
    ).toBe(true)
  })

  it('rejects a three-month direct call so only orchestration can chunk the wider period', async () => {
    const f = fixture()
    const result = await collectSamsungCancellationApi(f.tab, {
      from: '2026-07-08',
      to: '2026-10-08'
    })
    expect(result.receipt.cancellationQueryComplete).toBe(false)
    expect(result.receipt.issues).toContain('invalid_date_range')
    expect(f.calls).toEqual([])
  })

  it('requires the exact empty S13 list and four empty terminal cursors before certifying overseas scope', async () => {
    const f = fixture(undefined, (query) => {
      expect(query.data).toMatchObject({
        inqrStrtdt: '20260929',
        inqrEnddt: '20261002',
        cardUIzInqrDvC: '3',
        canDvC: '',
        no1PgeSize: 10,
        no1NextKeyCn: '',
        no2NextKeyCn: '',
        no3NextKeyCn: '',
        no4NextKeyCn: ''
      })
      expect(query.data).not.toHaveProperty('domCanIz')
      expect(query.data).not.toHaveProperty('no5NextKeyCn')
      query.success(response(query.service))
    })
    const result = await collectSamsungCancellationApi(f.tab, RANGE)
    expect(result.receipt.cancellationQueryComplete).toBe(true)
    expect(result.receipt.issues).toEqual([])
  })

  it.each(['missing_list', 'missing_cursor', 'terminal_cursor', 'bad_total', 'business_error'])(
    'refuses overseas completeness on %s even after complete domestic streams',
    async (fault) => {
      const f = fixture(undefined, (query) => {
        const value = response(query.service) as Record<string, unknown>
        if (fault === 'missing_list') delete value.hppRPFrnCanIzSub01SVO
        if (fault === 'missing_cursor') delete value.no4NextKeyCn
        if (fault === 'terminal_cursor') value.no1NextKeyCn = 'OPAQUE_NEXT'
        if (fault === 'bad_total') value.totDlngCt = 'not-a-count'
        if (fault === 'business_error') value.common = { procsRsDvC: '8' }
        query.success(value)
      })
      const result = await collectSamsungCancellationApi(f.tab, RANGE)
      expect(result.receipt).toMatchObject({
        cancellationQueryComplete: false,
        approvalComplete: false,
        statusComplete: false,
        cancellationComplete: false,
        complete: false
      })
      expect(result.receipt.issues).toContain('overseas_cancellation_scope_unverified')
    }
  )

  it('paginates S13 for counts but never treats nonempty overseas rows as domestic refund proof', async () => {
    let foreignPages = 0
    const f = fixture(undefined, (query) => {
      foreignPages++
      expect(query.data.cardUIzInqrDvC).toBe('3')
      if (foreignPages === 2) {
        expect(query.data.pgeNo).toBe(2)
        expect(query.data.no4NextKeyCn).toBe('FOREIGN_NEXT_4')
      }
      query.success(
        response(
          query.service,
          Array.from({ length: foreignPages === 1 ? 10 : 1 }, () => ({
            aprAm: 9000,
            wcCvtAm: 9000,
            aprPoCanFam: '1.25',
            slExcr: '1234.56',
            privateForeignField: 'PRIVATE_FOREIGN_VALUE'
          })),
          11,
          foreignPages === 1 ? 'FOREIGN_NEXT' : ''
        )
      )
    })
    const result = await collectSamsungCancellationApi(f.tab, RANGE)
    expect(result.rows).toEqual([])
    expect(result.receipt).toMatchObject({ pages: 4, cancellationQueryComplete: false })
    expect(result.receipt.issues).toEqual(
      expect.arrayContaining([
        'overseas_cancellation_rows_unverified',
        'overseas_cancellation_scope_unverified'
      ])
    )
    expect(foreignPages).toBe(2)
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_FOREIGN|wcCvtAm|aprPoCanFam|FOREIGN_NEXT/)
  })

  it('retains proved domestic snapshots while refusing completeness for nonempty overseas scope', async () => {
    const f = fixture(
      (query) =>
        query.success(
          response(
            query.service,
            query.service.endsWith('S51')
              ? [row(), row(1, { aprAm: -12300, canRcpdt: '20261002' })]
              : [row(1, { canProcsStsC: '2', canRcpdt: '20261002' })]
          )
        ),
      (query) => query.success(response(query.service, [{ wcCvtAm: 5000 }]))
    )
    const result = await collectSamsungCancellationApi(f.tab, RANGE)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      cancellationEvidence: true,
      cancellationAmount: 12300,
      needsReview: []
    })
    expect(result.receipt.cancellationQueryComplete).toBe(false)
    expect(result.receipt.issues).toContain('overseas_cancellation_scope_unverified')
  })

  it('rejects a card-scope change during the final overseas response', async () => {
    const f = fixture(undefined, (query) => {
      f.condition.isCstMngtNo = 'CHANGED_SYNTHETIC_SCOPE'
      query.success(response(query.service))
    })
    const result = await collectSamsungCancellationApi(f.tab, RANGE)
    expect(result.receipt.cancellationQueryComplete).toBe(false)
    expect(result.receipt.issues).toContain('card_scope_changed')
    expect(result.receipt.issues).toContain('overseas_cancellation_scope_unverified')
  })
})

describe('Samsung fixed private statement API collector', () => {
  it('certifies original approval status after complete empty S12 coverage without certifying a cancellation feed', async () => {
    const f = fixture()
    const result = await collectSamsungApi(f.tab, RANGE)
    expect(result.receipt).toMatchObject({
      approvalComplete: true,
      statusComplete: true,
      cancellationComplete: false,
      complete: false
    })
    expect(result.receipt.issues).toEqual(['cancellation_query_basis_unverified'])
  })

  it.each(['', ' ', '\t \r\n'])(
    'certifies a late full cancellation with explicit blank flag %j only after the S51 summary and S12 current status match',
    async (flag) => {
      const f = fixture((query) =>
        query.success(
          response(
            query.service,
            query.service.endsWith('S51')
              ? [
                  row(1, { aprDt: '20260817' }),
                  row(1, {
                    aprDt: '20260817',
                    aprAm: -12300,
                    canRcpdt: '20260906',
                    poCanDvC: flag
                  })
                ]
              : [
                  row(1, {
                    aprDt: '20260817',
                    canRcpdt: '20260906',
                    canProcsStsC: '2',
                    poCanDvC: flag
                  })
                ]
          )
        )
      )
      const result = await collectSamsungApi(f.tab, { from: '2026-08-17', to: '2026-08-17' })
      expect(result.receipt).toMatchObject({
        approvalComplete: true,
        statusComplete: true,
        cancellationComplete: false,
        complete: false
      })
      expect(result.rows[1]).toMatchObject({
        kind: 'status',
        cancellationAmount: 12300,
        needsReview: []
      })
      expect(result.rows[2]).toMatchObject({
        eventDate: '2026-09-06',
        cancellationEvidence: true,
        needsReview: []
      })
    }
  )

  it.each([
    'missing_s51_summary',
    'missing_s12_status',
    'wrong_event_day',
    'wrong_original_amount',
    'different_merchant',
    'pending',
    'unproved_partial',
    'extra_s12_snapshot',
    'cancelled_outside_original_range',
    'duplicate_summary',
    'positive_cancellation_marker'
  ] as const)(
    'does not certify original approval status when evidence is incomplete: %s',
    async (fault) => {
      const original = row()
      const summary = row(1, { aprAm: -12300, canRcpdt: '20261002' })
      const cancelled = row(1, { canProcsStsC: '1', canRcpdt: '20261002', poCanDvC: '' })
      if (fault === 'wrong_event_day') cancelled.canRcpdt = '20261003'
      if (fault === 'wrong_original_amount') original.aprAm = 15000
      if (fault === 'different_merchant') cancelled.mrcNm = '다른 상점'
      if (fault === 'pending') cancelled.canProcsStsC = '3'
      if (fault === 'unproved_partial') cancelled.poCanDvC = '2'
      if (fault === 'cancelled_outside_original_range') cancelled.aprDt = '20260901'
      if (fault === 'positive_cancellation_marker') original.poCanDvC = '99'
      const f = fixture((query) =>
        query.success(
          response(
            query.service,
            query.service.endsWith('S51')
              ? fault === 'missing_s51_summary' || fault === 'positive_cancellation_marker'
                ? [original]
                : fault === 'duplicate_summary'
                  ? [original, summary, summary]
                  : [original, summary]
              : fault === 'missing_s12_status' || fault === 'positive_cancellation_marker'
                ? []
                : fault === 'extra_s12_snapshot'
                  ? [cancelled, row(1, { canProcsStsC: '2', canRcpdt: '20261003', poCanDvC: '' })]
                  : [cancelled]
          )
        )
      )
      const result = await collectSamsungApi(f.tab, RANGE)
      expect(result.receipt).toMatchObject({
        statusComplete: false,
        cancellationComplete: false,
        complete: false
      })
    }
  )

  it.each(['empty_count_mismatch', 's12_error', 's12_bad_schema', 's12_scope_change'] as const)(
    'requires every verified S12 page before original status coverage: %s',
    async (fault) => {
      const f = fixture((query) => {
        if (query.service.endsWith('S51')) return query.success(response(query.service, [row()]))
        if (fault === 's12_error') return query.error()
        if (fault === 's12_scope_change') f.condition.isCstMngtNo = 'OTHER_SCOPE'
        if (fault === 's12_bad_schema')
          return query.success({ totDlngCt: 'PRIVATE_INVALID_COUNT', hppRPDomCanIzSub01SVO: [] })
        query.success(response(query.service, [], fault === 'empty_count_mismatch' ? 1 : 0))
      })
      if (fault === 's12_scope_change') {
        const originalExecute = f.execute.getMockImplementation()!
        f.execute.mockImplementation((script, userGesture) => {
          if (script.includes('"mode":"cancellation"')) f.condition.isCstMngtNo = 'OTHER_SCOPE'
          return originalExecute(script, userGesture)
        })
      }
      const result = await collectSamsungApi(f.tab, RANGE)
      expect(result.receipt).toMatchObject({
        statusComplete: false,
        cancellationComplete: false,
        complete: false
      })
    }
  )

  it.each(['1', '2'])(
    'proves only explicit nonpartial completed S12 cancellation code %s as cumulative',
    async (process) => {
      const f = fixture((query) =>
        query.success(
          response(
            query.service,
            query.service.endsWith('S51')
              ? [row()]
              : [row(1, { canProcsStsC: process, canRcpdt: '20261002', poCanDvC: '' })]
          )
        )
      )
      const result = await collectSamsungApi(f.tab, RANGE)
      expect(result.rows[1]).toMatchObject({
        status: 'cancelled',
        amount: 12300,
        cancellationAmount: 12300,
        cancellationEvidence: true,
        cancellationAmountType: 'cumulative',
        netAmount: 0,
        needsReview: []
      })
      expect(result.receipt).toMatchObject({
        approvalComplete: true,
        cancellationComplete: false,
        statusComplete: false,
        complete: false
      })
      expect(f.calls).toHaveLength(2)
    }
  )

  it.each([null, undefined, 0, '0', 'N', 'Y', '99'])(
    'does not promote a missing or unknown partial flag %s to full cancellation',
    async (flag) => {
      const cancellation = row(1, { canProcsStsC: '1', canRcpdt: '20261002' })
      if (flag === undefined) delete cancellation.poCanDvC
      else cancellation.poCanDvC = flag
      const f = fixture((query) =>
        query.success(response(query.service, query.service.endsWith('S51') ? [] : [cancellation]))
      )
      const result = await collectSamsungApi(f.tab, RANGE)
      expect(result.rows[0]).toMatchObject({
        status: 'unknown',
        cancellationAmount: null,
        netAmount: null
      })
      expect(result.rows[0].cancellationEvidence).not.toBe(true)
      expect(result.receipt).toMatchObject({
        statusComplete: false,
        cancellationComplete: false,
        complete: false
      })
      expect(result.rows[0].needsReview).toContain(
        flag == null
          ? 'cancellation_partial_flag_unavailable'
          : 'cancellation_partial_flag_unrecognized'
      )
    }
  )

  it('uses only the official single S41 event amount, never its untrusted total or S12 original amount', async () => {
    const f = fixture((query) => {
      if (query.service.endsWith('S41')) {
        expect(query.data).toEqual({
          aprDt: '20261002',
          cdnoId: 'SYNTHETIC_OPAQUE_CARD_ID',
          aprT: '091213',
          aprno: '00000001'
        })
        query.success({
          common: { procsRsDvC: '0' },
          aprAm: '-12300',
          hppRPPoCanIzSub01SVO: [
            {
              aprPoCanDtm: '20261002121544',
              aprPoCanAm: '-4000',
              privateEvent: 'PRIVATE_EVENT_VALUE'
            }
          ]
        })
      } else
        query.success(
          response(
            query.service,
            query.service.endsWith('S51')
              ? [row(), row(1, { aprAm: -4000, poCanDvC: '1', canRcpdt: '20261002' })]
              : [
                  row(1, {
                    cdnoId: 'SYNTHETIC_OPAQUE_CARD_ID',
                    poCanDvC: '1',
                    canProcsStsC: '1',
                    canRcpdt: '20261002'
                  })
                ]
          )
        )
    })
    const before = JSON.stringify(f.condition)
    const result = await collectSamsungApi(f.tab, RANGE)
    expect(result.rows[2]).toMatchObject({
      amount: 12300,
      cancellationAmount: 4000,
      netAmount: 8300,
      status: 'partially_cancelled',
      cancellationEvidence: true,
      cancellationAmountType: 'cumulative',
      needsReview: []
    })
    expect(result.rows[2].cancellationEventId).toMatch(/^[a-f0-9]{64}$/)
    expect(result.rows[1]).toMatchObject({
      kind: 'status',
      amount: 12300,
      cancellationAmount: 4000,
      cancellationAmountType: 'cumulative',
      netAmount: 8300,
      needsReview: []
    })
    expect(result.receipt).toMatchObject({
      statusComplete: true,
      cancellationComplete: false,
      complete: false
    })
    expect(f.calls.map((call) => call.service)).toEqual([
      'SHPPRP0801S51',
      'SHPPRP0801S12',
      'SHPPRP0801S41'
    ])
    expect(JSON.stringify(f.condition)).toBe(before)
    for (const secret of ['SYNTHETIC_OPAQUE_CARD_ID', 'PRIVATE_EVENT_VALUE', '20261002121544'])
      expect(JSON.stringify(result)).not.toContain(secret)
  })

  it.each([
    'multiple',
    'duplicate_timestamp',
    'paging',
    'wrong_day',
    'malformed_timestamp',
    'full_original_amount',
    'zero',
    'missing_amount',
    'service_error'
  ] as const)(
    'keeps partial cancellation under review for unsafe S41 evidence: %s',
    async (fault) => {
      const f = fixture((query) => {
        if (query.service.endsWith('S41')) {
          if (fault === 'service_error') return query.error()
          const events: SourceRow[] = [
            {
              aprPoCanDtm:
                fault === 'wrong_day'
                  ? '20261001121544'
                  : fault === 'malformed_timestamp'
                    ? '20261002'
                    : '20261002121544',
              aprPoCanAm:
                fault === 'full_original_amount'
                  ? -12300
                  : fault === 'zero'
                    ? 0
                    : fault === 'missing_amount'
                      ? null
                      : -4000
            }
          ]
          if (fault === 'multiple' || fault === 'duplicate_timestamp')
            events.push({
              aprPoCanDtm: fault === 'duplicate_timestamp' ? '20261002121544' : '20261002131544',
              aprPoCanAm: -2000
            })
          query.success({
            hppRPPoCanIzSub01SVO: events,
            ...(fault === 'paging' ? { no1NextKeyCn: 'NEXT_PRIVATE_CURSOR' } : {})
          })
        } else
          query.success(
            response(
              query.service,
              query.service.endsWith('S51')
                ? []
                : [
                    row(1, {
                      cdnoId: 'PRIVATE_CARD_ID',
                      poCanDvC: '1',
                      canProcsStsC: '2',
                      canRcpdt: '20261002'
                    })
                  ]
            )
          )
      })
      const result = await collectSamsungApi(f.tab, RANGE)
      expect(result.rows[0]).toMatchObject({ cancellationAmount: null, netAmount: null })
      expect(result.rows[0].cancellationEvidence).not.toBe(true)
      expect(result.rows[0].needsReview).toContain('cancellation_amount_unverified')
      expect(result.receipt).toMatchObject({
        cancellationComplete: false,
        statusComplete: false,
        complete: false
      })
      expect(JSON.stringify(result)).not.toContain('PRIVATE_CARD_ID')
      expect(JSON.stringify(result)).not.toContain('NEXT_PRIVATE_CURSOR')
    }
  )

  it('keeps a verified cancellation identity stable when its official amount changes', async () => {
    let amount = -4000
    const f = fixture((query) => {
      if (query.service.endsWith('S41'))
        query.success({
          hppRPPoCanIzSub01SVO: [{ aprPoCanDtm: '20261002121544', aprPoCanAm: amount }]
        })
      else
        query.success(
          response(
            query.service,
            query.service.endsWith('S51')
              ? []
              : [
                  row(1, {
                    cdnoId: 'SYNTHETIC_CARD_ID',
                    poCanDvC: '1',
                    canProcsStsC: '1',
                    canRcpdt: '20261002'
                  })
                ]
          )
        )
    })
    const first = await collectSamsungApi(f.tab, RANGE)
    amount = -4500
    const second = await collectSamsungApi(f.tab, RANGE)
    expect(first.rows[0].sourceId).toBe(second.rows[0].sourceId)
    expect(first.rows[0].cancellationEventId).toBe(second.rows[0].cancellationEventId)
    expect(first.rows[0].cancellationAmount).toBe(4000)
    expect(second.rows[0].cancellationAmount).toBe(4500)
  })

  it('returns fixed S41 shape diagnostics with no private fields and preserves duplicate uncertainty', async () => {
    const f = fixture((query) => {
      if (query.service.endsWith('S41'))
        query.success({
          hppRPPoCanIzSub01SVO: [
            { aprPoCanDtm: '20261002121544', aprPoCanAm: -4000 },
            { aprPoCanDtm: '20261002121544', aprPoCanAm: -2000 }
          ]
        })
      else
        query.success(
          response(query.service, [
            row(1, { cdnoId: 'PRIVATE_PROBE_CARD', poCanDvC: '1', canProcsStsC: '1' })
          ])
        )
    })
    const result = await probeSamsungCancellationDetails(f.tab, RANGE)
    expect(result).toMatchObject({
      ok: true,
      firstPageRows: 1,
      reportedTotal: 1,
      partialFlags: {
        missing: 0,
        emptyString: 0,
        whitespace: 0,
        code0: 0,
        code1: 1,
        code2: 0,
        flagN: 0,
        flagY: 0,
        other: 0
      },
      processingStates: {
        missing: 0,
        empty: 0,
        completedApproval: 1,
        completedPayment: 0,
        pending: 0,
        other: 0
      },
      partialCandidates: 1,
      detailIdentityCandidates: 1,
      detailRows: 2,
      validTimestampRows: 2,
      validAmountRows: 2,
      duplicateTimestampRows: 1,
      pagingFieldsPresent: false
    })
    for (const secret of ['PRIVATE_PROBE_CARD', '00000001', '20261002121544', '4000', '2000'])
      expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('returns fixed raw flag histogram even when no public S41 popup candidate exists', async () => {
    const flags = ['', null, ' ', '0', '2', 'N', 'Y', 'PRIVATE_ARBITRARY_FLAG']
    const processes = [null, '', '1', '2', '3', 'PRIVATE_PROCESS_VALUE', '1', '2']
    const f = fixture((query) =>
      query.success(
        response(
          query.service,
          flags.map((flag, index) =>
            row(index + 1, { poCanDvC: flag, canProcsStsC: processes[index] })
          )
        )
      )
    )
    const result = await probeSamsungCancellationDetails(f.tab, RANGE)
    expect(result).toMatchObject({
      ok: false,
      issue: 'no_partial_cancellation_row',
      firstPageRows: 8,
      reportedTotal: 8,
      partialFlags: {
        missing: 1,
        emptyString: 1,
        whitespace: 1,
        code0: 1,
        code1: 0,
        code2: 1,
        flagN: 1,
        flagY: 1,
        other: 1
      },
      processingStates: {
        missing: 1,
        empty: 1,
        completedApproval: 2,
        completedPayment: 2,
        pending: 1,
        other: 1
      },
      partialCandidates: 0,
      detailIdentityCandidates: 0
    })
    expect(f.calls.map((call) => call.service)).toEqual([
      'SHPPRP0801S12',
      'SHPPRP0801S51',
      'SHPPRP0801S13'
    ])
    for (const secret of [
      'PRIVATE_ARBITRARY_FLAG',
      'PRIVATE_PROCESS_VALUE',
      '00000001',
      '4321',
      '12300'
    ])
      expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('distinguishes a public partial popup flag from missing private identity without querying S41', async () => {
    const f = fixture((query) =>
      query.success(response(query.service, [row(1, { poCanDvC: '1', canProcsStsC: '2' })]))
    )
    const result = await probeSamsungCancellationDetails(f.tab, RANGE)
    expect(result).toMatchObject({
      ok: false,
      issue: 'partial_detail_identity_unavailable',
      partialCandidates: 1,
      detailIdentityCandidates: 0,
      partialFlags: { code1: 1 }
    })
    expect(f.calls).toHaveLength(3)
  })

  it('diagnoses padded foreign terminal cursors without treating them as verified termination', async () => {
    const f = fixture(undefined, (query) =>
      query.success({
        ...response(query.service),
        no1NextKeyCn: ' ',
        no2NextKeyCn: '\t',
        no3NextKeyCn: '',
        no4NextKeyCn: 'PRIVATE_CURSOR'
      })
    )
    const result = await probeSamsungCancellationDetails(f.tab, RANGE)
    expect(result.streams?.overseas_cancellation).toEqual({
      pages: [
        {
          page: 1,
          observedRows: 0,
          totalType: 'string',
          total: 0,
          sourceType: 'array',
          rowCount: 0,
          cursors: ['whitespace', 'whitespace', 'empty', 'nonempty_string']
        }
      ],
      decision: 'terminal_cursor_remaining'
    })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CURSOR')
    expect(f.calls).toHaveLength(3)
  })

  it('reports per-service totals changing across pages using only numeric metadata', async () => {
    const f = fixture((query) =>
      query.success(
        query.service.endsWith('S12')
          ? response(
              query.service,
              Array.from({ length: 10 }, (_, i) => row(i + 1)),
              query.data.pgeNo ? 21 : 20,
              'PRIVATE_CURSOR'
            )
          : response(query.service)
      )
    )
    const result = await probeSamsungCancellationDetails(f.tab, RANGE)
    expect(result.streams?.cancellation).toMatchObject({
      pages: [
        { page: 1, total: 20, rowCount: 10, observedRows: 10 },
        { page: 2, total: 21, rowCount: 10, observedRows: 20 }
      ],
      decision: 'total_changed'
    })
    expect(result.streams?.approval?.decision).toBe('count_and_cursor_terminal')
    expect(result.streams?.overseas_cancellation?.decision).toBe('count_and_cursor_terminal')
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_CURSOR|00000001|4321|12300/)
    expect(f.calls.filter((call) => call.service.endsWith('S12'))).toHaveLength(2)
  })

  it('keeps malformed overseas schema metadata while excluding raw values', async () => {
    const f = fixture(undefined, (query) =>
      query.success({
        totDlngCt: 'PRIVATE_TOTAL',
        hppRPFrnCanIzSub01SVO: null,
        no2NextKeyCn: null,
        no3NextKeyCn: 0,
        no4NextKeyCn: { private: 'SECRET' }
      })
    )
    const result = await probeSamsungCancellationDetails(f.tab, RANGE)
    expect(result.streams?.overseas_cancellation).toEqual({
      pages: [
        {
          page: 1,
          observedRows: 0,
          totalType: 'string',
          total: null,
          sourceType: 'null',
          rowCount: null,
          cursors: ['missing', 'null', 'number', 'other']
        }
      ],
      decision: 'invalid_response'
    })
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_TOTAL|SECRET/)
  })

  it('diagnoses raw later zero totals while applying the saved first-page total and blank cursor normalization', async () => {
    const f = fixture(
      (query) => {
        const page = Number(query.data.pgeNo || 1)
        const source = response(
          query.service,
          Array.from({ length: 10 }, (_, i) => row((page - 1) * 10 + i + 1)),
          page === 1 ? 20 : 0,
          page === 1 ? 'NEXT' : ''
        )
        query.success(
          Object.fromEntries(
            Object.entries(source).map(([key, value]) => [
              key,
              /^no[1-9]NextKeyCn$/.test(key) && value === '' ? ' ' : value
            ])
          )
        )
      },
      (query) =>
        query.success({
          ...response(query.service),
          no1NextKeyCn: ' ',
          no2NextKeyCn: ' ',
          no3NextKeyCn: ' ',
          no4NextKeyCn: ' '
        })
    )
    const result = await probeSamsungCancellationDetails(f.tab, RANGE)
    expect(result.streams?.cancellation).toMatchObject({
      pages: [
        { total: 20, observedRows: 10 },
        { total: 0, observedRows: 20 }
      ],
      decision: 'count_and_cursor_terminal'
    })
    expect(result.streams?.approval?.decision).toBe('count_and_cursor_terminal')
    expect(result.streams?.overseas_cancellation).toMatchObject({
      pages: [
        { total: 0, rowCount: 0, cursors: ['whitespace', 'whitespace', 'whitespace', 'whitespace'] }
      ],
      decision: 'count_and_cursor_terminal'
    })
    expect(f.calls).toHaveLength(5)
  })

  it('rejects unsafe probe ranges and changed navigation before returning any detail evidence', async () => {
    const f = fixture((query) => {
      f.setUrl('https://www.samsungcard.com/personal/main.jsp')
      query.success(
        response(query.service, [
          row(1, { cdnoId: 'PRIVATE_PROBE_CARD', poCanDvC: '1', canProcsStsC: '1' })
        ])
      )
    })
    expect(
      await probeSamsungCancellationDetails(f.tab, { from: '2026-09-01', to: '2026-10-02' })
    ).toEqual({ ok: false, issue: 'invalid_date_range' })
    expect(f.execute).not.toHaveBeenCalled()
    expect(await probeSamsungCancellationDetails(f.tab, RANGE)).toEqual({
      ok: false,
      issue: 'navigation_changed'
    })
    expect(f.calls).toHaveLength(1)
  })

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
      query.success(
        response(query.service, rows, total, start + rows.length < total ? `PAGE_${page}` : '')
      )
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
    expect(result.receipt.issues).toContain('service_error_ajax_callback_error')
    expect(result.receipt.issues).toContain('service_error_cancellation_stream')
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
    { identity: '123456789012345', suffix: '2345' },
    { identity: '************317', suffix: '*317' },
    { identity: '1234********43**', suffix: '43**' }
  ])(
    'preserves actual last positions and a private stable key (%#)',
    async ({ identity, suffix }) => {
      const f = fixture((query) =>
        query.success(
          response(
            query.service,
            query.service.endsWith('S51') ? [row(1, { itgCdnoe: identity })] : []
          )
        )
      )
      const result = await collectSamsungApi(f.tab, RANGE)
      expect(result.rows[0].cardLast4).toBe(suffix)
      expect(result.rows[0].cardKey).toMatch(/^[a-f0-9]{64}$/)
      expect(result.rows[0].needsReview).toEqual([])
      expect(result.receipt.approvalComplete).toBe(true)
      expect(JSON.stringify(result.receipt)).not.toContain(identity)
      expect(JSON.stringify(result.receipt)).not.toContain(suffix)
    }
  )

  it.each([
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

  it('does not treat a nonnumeric 15-character suffix as an official three-digit tail', async () => {
    const f = fixture((query) =>
      query.success(
        response(
          query.service,
          query.service.endsWith('S51') ? [row(1, { itgCdnoe: '************ABC' })] : []
        )
      )
    )
    const result = await collectSamsungApi(f.tab, RANGE)
    expect(result.rows[0].cardLast4).toBeUndefined()
    expect(result.rows[0].needsReview).toContain('card_last4_unavailable')
    expect(result.receipt.issues).not.toContain('card_official_tail_3_digits')
    expect(result.receipt.issues).not.toContain('card_prefix_masked')
  })

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

  it.each(['1', '2'])(
    'never treats partial flag %s or pending padded blank cancellation original amounts as actual refunds',
    async (flag) => {
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
                    poCanDvC: flag
                  }),
                  row(2, { canProcsStsC: '3', canRcpdt: '20261002', poCanDvC: ' ' })
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
    }
  )

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
    expect(failed.receipt.issues).toEqual([
      'service_error_common_response_rejected',
      'service_error_approval_stream',
      'service_error'
    ])
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_SERVICE_ERROR')
  })

  it.each([
    'response_missing',
    'common_response_rejected',
    'ajax_callback_error',
    'invocation_exception'
  ] as const)(
    'reports only the fixed service failure category %s and does not retry',
    async (failure) => {
      const f = fixture((query) => {
        if (failure === 'response_missing') query.success(null)
        else if (failure === 'common_response_rejected')
          query.success({
            common: { procsRsDvC: 'PRIVATE_RESULT_CODE' },
            message: 'PRIVATE_SERVER_MESSAGE'
          })
        else if (failure === 'ajax_callback_error') query.error()
        else throw new Error('PRIVATE_JAVASCRIPT_EXCEPTION')
      })
      const result = await collectSamsungApi(f.tab, RANGE)
      expect(result.receipt.issues).toEqual([
        'service_error_' + failure,
        'service_error_approval_stream',
        'service_error'
      ])
      expect(result.rows).toEqual([])
      expect(result.receipt.approvalComplete).toBe(false)
      expect(f.calls).toHaveLength(1)
      for (const secret of [
        'PRIVATE_RESULT_CODE',
        'PRIVATE_SERVER_MESSAGE',
        'PRIVATE_JAVASCRIPT_EXCEPTION'
      ])
        expect(JSON.stringify(result)).not.toContain(secret)
    }
  )

  it('rejects a forged service failure category without returning it', async () => {
    const f = fixture()
    f.execute.mockResolvedValue({
      ok: false,
      issue: 'service_error',
      serviceFailure: 'PRIVATE_ARBITRARY_ERROR'
    })
    const result = await collectSamsungApi(f.tab, RANGE)
    expect(result.receipt.issues).toEqual(['invalid_response'])
    expect(JSON.stringify(result)).not.toContain('PRIVATE_ARBITRARY_ERROR')
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

  it('waits only for initial unknown Samsung markers, then performs each API query once', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.auth
      .mockResolvedValueOnce({ issuer: 'samsung_card', state: 'unknown' })
      .mockResolvedValueOnce({ issuer: 'samsung_card', state: 'unknown' })
    const pending = collectSamsungApi(f.tab, RANGE)
    await vi.advanceTimersByTimeAsync(249)
    expect(f.auth).toHaveBeenCalledTimes(1)
    expect(f.execute).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.auth).toHaveBeenCalledTimes(2)
    expect(f.execute).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)
    const result = await pending
    expect(result.receipt.approvalComplete).toBe(true)
    expect(f.calls.map((query) => query.service)).toEqual(['SHPPRP0801S51', 'SHPPRP0801S12'])
    expect(f.tab.view.webContents.listenerCount('did-start-navigation')).toBe(0)
    expect(f.tab.view.webContents.listenerCount('destroyed')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    { issuer: 'samsung_card', state: 'signed_out', issue: 'signed_out' },
    { issuer: 'lotte_card', state: 'unknown', issue: 'session_unverified' },
    { issuer: 'lotte_card', state: 'signed_in', issue: 'session_unverified' }
  ] as const)('does not wait for initial $issuer/$state', async ({ issuer, state, issue }) => {
    vi.useFakeTimers()
    const f = fixture()
    f.auth.mockResolvedValue({ issuer, state })
    const result = await collectSamsungApi(f.tab, RANGE)
    expect(result.receipt.issues).toEqual([issue])
    expect(result.receipt.elapsedMs).toBe(0)
    expect(f.auth).toHaveBeenCalledTimes(1)
    expect(f.execute).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['unknown', 'pending'] as const)(
    'bounds initial $s session reads to ten seconds without any API requests',
    async (read) => {
      vi.useFakeTimers()
      const f = fixture()
      f.auth.mockResolvedValue({ issuer: 'samsung_card', state: 'unknown' })
      if (read === 'pending') {
        f.auth
          .mockResolvedValueOnce({ issuer: 'samsung_card', state: 'unknown' })
          .mockImplementation(() => new Promise(() => undefined))
      }
      const pending = collectSamsungApi(f.tab, RANGE)
      await vi.advanceTimersByTimeAsync(10_000)
      const result = await pending
      expect(result.receipt).toMatchObject({
        issues: ['session_unverified'],
        elapsedMs: 10_000,
        pages: 0,
        approvalComplete: false
      })
      expect(f.auth).toHaveBeenCalledTimes(read === 'pending' ? 2 : 40)
      expect(f.execute).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['signed_out', 'wrong_issuer'] as const)(
    'ends initial marker waiting immediately on $s',
    async (change) => {
      vi.useFakeTimers()
      const f = fixture()
      f.auth
        .mockResolvedValueOnce({ issuer: 'samsung_card', state: 'unknown' })
        .mockResolvedValueOnce(
          change === 'signed_out'
            ? { issuer: 'samsung_card', state: 'signed_out' }
            : { issuer: 'lotte_card', state: 'unknown' }
        )
      const pending = collectSamsungApi(f.tab, RANGE)
      await vi.advanceTimersByTimeAsync(250)
      const result = await pending
      expect(result.receipt.issues).toEqual([
        change === 'signed_out' ? 'signed_out' : 'session_unverified'
      ])
      expect(f.auth).toHaveBeenCalledTimes(2)
      expect(f.execute).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['abort', 'navigation', 'destroy', 'replace', 'silent_url'] as const)(
    'interrupts initial marker waiting immediately on %s even during a pending read',
    async (change) => {
      vi.useFakeTimers()
      const f = fixture()
      const originalContents = f.tab.view.webContents
      const controller = new AbortController()
      f.auth
        .mockResolvedValueOnce({ issuer: 'samsung_card', state: 'unknown' })
        .mockImplementation(() => new Promise(() => undefined))
      const pending = collectSamsungApi(f.tab, RANGE, { signal: controller.signal })
      await vi.advanceTimersByTimeAsync(250)
      if (change === 'abort') controller.abort()
      else if (change === 'navigation') f.setUrl('https://www.samsungcard.com/personal/main.jsp')
      else if (change === 'destroy') f.destroy()
      else if (change === 'replace')
        Object.defineProperty(f.tab.view, 'webContents', { value: {}, configurable: true })
      else f.setUrl('https://www.samsungcard.com/personal/main.jsp', false)
      if (change === 'replace' || change === 'silent_url') await vi.advanceTimersByTimeAsync(250)
      const result = await pending
      expect(result.receipt.issues).toEqual([change === 'abort' ? 'aborted' : 'navigation_changed'])
      expect(result.receipt.elapsedMs).toBe(
        change === 'replace' || change === 'silent_url' ? 500 : 250
      )
      expect(f.auth).toHaveBeenCalledTimes(2)
      expect(f.execute).not.toHaveBeenCalled()
      expect(originalContents.listenerCount('did-start-navigation')).toBe(0)
      expect(originalContents.listenerCount('destroyed')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each([2, 3])(
    'does not wait for unknown markers after the first API request (read %s)',
    async (read) => {
      vi.useFakeTimers()
      const f = fixture()
      for (let index = 1; index < read; index++)
        f.auth.mockResolvedValueOnce({ issuer: 'samsung_card', state: 'signed_in' })
      f.auth.mockResolvedValueOnce({ issuer: 'samsung_card', state: 'unknown' })
      const result = await collectSamsungApi(f.tab, RANGE)
      expect(result.receipt.issues).toEqual(['session_unverified'])
      expect(result.receipt.elapsedMs).toBe(0)
      expect(result.receipt.approvalComplete).toBe(false)
      expect(f.auth).toHaveBeenCalledTimes(read)
      expect(f.calls).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('times out a nonresponding service without retrying or returning partial response text', async () => {
    vi.useFakeTimers()
    const f = fixture(() => undefined)
    const pending = collectSamsungApi(f.tab, RANGE)
    // Let native WebCrypto finish before advancing fake service timers. This
    // checks an actual stalled AJAX request rather than timing out preprocessing.
    await vi.waitFor(() => expect(f.calls).toHaveLength(1), { timeout: 5000 })
    await vi.advanceTimersByTimeAsync(16_100)
    const result = await pending
    expect(result.receipt.issues).toEqual(['request_timeout'])
    expect(result.rows).toEqual([])
    expect(f.calls).toHaveLength(1)
  })
})
