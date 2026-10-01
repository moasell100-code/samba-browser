import { describe, expect, it, vi } from 'vitest'
import type { FinanceListRow, FinancePageCapture } from '../src/shared/finance-capture'
import {
  FinanceCaptureStore,
  FINANCE_CAPTURE_MAX_ITEMS,
  FINANCE_CAPTURE_TTL_MS
} from '../src/main/finance/capture-store'
import { isFinanceCaptureUrl, validateApprovalStatus } from '../src/main/finance/capture-schema'

function page(value = '12,345'): FinancePageCapture {
  return {
    frames: [
      {
        origin: 'https://www.hyundaicard.com',
        pathname: '/history',
        tables: [
          {
            index: 0,
            rows: [[{ text: value, header: false, rowSpan: 1, colSpan: 1 }]],
            hiddenRows: 0,
            hasNestedTable: false
          }
        ]
      }
    ],
    failedFrames: 0,
    skippedFrames: 0
  }
}

describe('finance capture boundary', () => {
  it.each(['https://www.hyundaicard.com/history', 'https://hyundaicard.com/'])(
    'allows %s',
    (url) => {
      expect(isFinanceCaptureUrl(url)).toBe(true)
    }
  )
  it.each([
    'http://www.hyundaicard.com/',
    'https://www.hyundaicard.com.evil.test/',
    'https://evil.test/?site=hyundaicard.com',
    'https://www.hyundaicard.com:444/',
    'https://user:secret@www.hyundaicard.com/',
    'file:///hyundaicard.com',
    'https://unverified.hyundaicard.com/'
  ])('refuses %s', (url) => {
    expect(isFinanceCaptureUrl(url)).toBe(false)
  })
  it.each(['부분취소', '미승인', '승인대기', '취소접수', '', 'something new'])(
    'unknown status stays unknown: %s',
    (value) => {
      expect(validateApprovalStatus(value)).toBe('unknown')
    }
  )
  it('recognizes only explicit status vocabulary', () => {
    expect(validateApprovalStatus('승인완료')).toBe('active')
    expect(validateApprovalStatus('취소완료')).toBe('cancelled')
  })
})

describe('visible duplicate row review metadata', () => {
  function row(approval: string, amount = '10,000'): FinanceListRow {
    return {
      head: [
        { field: 'name', text: 'synthetic-merchant' },
        { field: 'date', text: '2026.10.01' },
        { field: 'time', text: '12:34:56' },
        { field: 'card', text: 'synthetic-card 9876' },
        { field: 'payment_type', text: '일시불' },
        { field: 'amount', text: amount }
      ],
      details: [{ label: '승인번호', value: approval }],
      detailsVisible: true,
      sourceRowId: approval
    }
  }

  function listPage(rows: FinanceListRow[]): FinancePageCapture {
    return {
      frames: [
        {
          origin: 'https://www.samsungcard.com',
          pathname: '/personal/card/activity/UHPPRP0801M0.jsp',
          tables: [],
          lists: [
            {
              adapter: 'samsung_history_list_v1',
              rows,
              hiddenRows: 0,
              unrecognizedRows: 0,
              hasMore: false
            }
          ]
        }
      ],
      failedFrames: 0,
      skippedFrames: 0
    }
  }

  it('flags repeated visible head tuples but retains every row including distinct approvals', () => {
    const store = new FinanceCaptureStore()
    const input = listPage([row('00112233'), row('00112234'), row('00112235')])
    const receipt = store.save(input)
    expect(receipt.listSummaries![0].duplicateVisibleRowCount).toBe(2)
    expect(receipt.listRowCount).toBe(3)
    expect(receipt.issues).toContain('duplicate_rows_review')
    expect(
      store
        .readForReview(receipt.captureId)!
        .page.frames[0].lists![0].rows.map((item) => item.sourceRowId)
    ).toEqual(['00112233', '00112234', '00112235'])
    expect(JSON.stringify(receipt)).not.toMatch(
      /synthetic-merchant|synthetic-card|"00112233"|10,000|"head"|"digest"/
    )
    store.clear()
  })

  it('does not group rows with a different displayed amount or normalize the captured text', () => {
    const store = new FinanceCaptureStore()
    const receipt = store.save(
      listPage([row('00112233'), row('00112234', '20,000'), row('00112235', '10,000 ')])
    )
    expect(receipt.listSummaries![0].duplicateVisibleRowCount).toBe(0)
    expect(receipt.issues).not.toContain('duplicate_rows_review')
    expect(receipt.listRowCount).toBe(3)
    store.clear()
  })

  it('counts repeated rows within each list rather than matching unrelated list views', () => {
    const input = listPage([row('00112233')])
    input.frames[0].lists!.push(structuredClone(input.frames[0].lists![0]))
    const store = new FinanceCaptureStore()
    const receipt = store.save(input)
    expect(receipt.listSummaries!.map((summary) => summary.duplicateVisibleRowCount)).toEqual([
      0, 0
    ])
    expect(receipt.issues).not.toContain('duplicate_rows_review')
    expect(receipt.listRowCount).toBe(2)
    store.clear()
  })
})

describe('unrecognized row diagnostic privacy boundary', () => {
  function diagnosticPage(diagnostics: unknown[]): FinancePageCapture {
    return {
      frames: [
        {
          origin: 'https://www.hyundaicard.com',
          pathname: '/cpa/cb/CPACB0101_01.hc',
          tables: [],
          lists: [
            {
              adapter: 'hyundai_history_list_v1',
              rows: [],
              hiddenRows: 0,
              unrecognizedRows: 6,
              hasMore: false,
              unrecognizedDiagnostics: diagnostics
            }
          ]
        }
      ],
      failedFrames: 0,
      skippedFrames: 0
    } as FinancePageCapture
  }

  const safe = {
    rowIndex: 4,
    reason: 'empty_fields',
    linkCount: 1,
    nameCount: 1,
    metadataCount: 4,
    amountCount: 1,
    emptyFields: ['time']
  }

  it('returns only bounded fixed diagnostic metadata and preserves the incomplete capture issue', () => {
    const store = new FinanceCaptureStore()
    const receipt = store.save(diagnosticPage([safe]))
    expect(receipt.listSummaries![0].unrecognizedDiagnostics).toEqual([safe])
    expect(receipt.issues).toContain('unrecognized_rows')
    expect(receipt.listRowCount).toBe(0)
    expect(receipt.listSummaries![0].sourceRowIdCount).toBe(0)
    store.clear()
  })

  it('rejects diagnostic messages, text, values, identifiers and fields outside the fixed vocabulary', () => {
    const store = new FinanceCaptureStore()
    const invalid = [
      { ...safe, text: 'private-merchant' },
      { ...safe, value: 'private-amount' },
      { ...safe, id: 'private-approval' },
      { ...safe, message: 'private-error' },
      { ...safe, reason: 'private-merchant' },
      { ...safe, emptyFields: ['private-merchant'] },
      { ...safe, linkCount: 'private-card' }
    ]
    for (const bad of invalid) {
      expect(() => store.save(diagnosticPage([bad]))).toThrow('finance_capture_invalid')
    }
    store.clear()
  })

  it('rejects unbounded indices/counts, more than five diagnostics, and another issuer adapter', () => {
    const store = new FinanceCaptureStore()
    for (const bad of [
      { ...safe, rowIndex: -1 },
      { ...safe, rowIndex: 1000 },
      { ...safe, linkCount: 1001 },
      { ...safe, metadataCount: 0.5 }
    ])
      expect(() => store.save(diagnosticPage([bad]))).toThrow('finance_capture_invalid')
    expect(() => store.save(diagnosticPage(Array(6).fill(safe)))).toThrow('finance_capture_invalid')
    const other = diagnosticPage([safe])
    other.frames[0].origin = 'https://www.samsungcard.com'
    other.frames[0].pathname = '/personal/card/activity/UHPPRP0801M0.jsp'
    other.frames[0].lists![0].adapter = 'samsung_history_list_v1'
    expect(() => store.save(other)).toThrow('finance_capture_invalid')
    store.clear()
  })
})

describe('finance capture in-memory store', () => {
  it('erases expired captures on a timer even when no later read happens', () => {
    vi.useFakeTimers()
    try {
      const store = new FinanceCaptureStore()
      store.save(page())
      expect(vi.getTimerCount()).toBe(1)
      vi.advanceTimersByTime(FINANCE_CAPTURE_TTL_MS)
      expect(vi.getTimerCount()).toBe(0)
      store.clear()
    } finally {
      vi.useRealTimers()
    }
  })
  it('returns metadata only and always labels the generic capture preview-only', () => {
    const store = new FinanceCaptureStore()
    const receipt = store.save(page('private merchant 900000'))
    expect(receipt.previewOnly).toBe(true)
    expect(receipt.issues).toContain('pagination_unverified')
    expect(receipt.issues).toContain('query_range_unverified')
    expect(JSON.stringify(receipt)).not.toContain('private merchant')
    expect(JSON.stringify(receipt)).not.toContain('900000')
    expect(store.readForReview(receipt.captureId)?.page.frames[0].tables[0].rows[0][0].text).toBe(
      'private merchant 900000'
    )
  })
  it('prevents callers from changing stored data through object references', () => {
    const store = new FinanceCaptureStore()
    const input = page()
    const receipt = store.save(input)
    input.frames[0].tables[0].rows[0][0].text = 'changed'
    receipt.issues.length = 0
    const read = store.readForReview(receipt.captureId)!
    read.page.frames[0].tables[0].rows[0][0].text = 'changed again'
    expect(store.readForReview(receipt.captureId)!.page.frames[0].tables[0].rows[0][0].text).toBe(
      '12,345'
    )
    expect(store.readForReview(receipt.captureId)!.receipt.issues.length).toBeGreaterThan(0)
  })
  it('expires data and evicts oldest captures at the item bound', () => {
    let now = 1000
    const store = new FinanceCaptureStore(() => now)
    const first = store.save(page())
    for (let i = 0; i < FINANCE_CAPTURE_MAX_ITEMS; i += 1) store.save(page(String(i)))
    expect(store.readForReview(first.captureId)).toBeNull()
    const latest = store.save(page())
    now += FINANCE_CAPTURE_TTL_MS
    expect(store.readForReview(latest.captureId)).toBeNull()
  })
  it('reports incomplete frames and complex/hidden rows without approving a capture', () => {
    const store = new FinanceCaptureStore()
    const input = page()
    input.failedFrames = 1
    input.frames[0].tables[0].hiddenRows = 1
    input.frames[0].tables[0].rows[0][0].colSpan = 2
    expect(store.save(input).issues).toEqual(
      expect.arrayContaining(['frame_incomplete', 'hidden_rows', 'complex_table'])
    )
    expect(
      store.save({
        frames: [{ origin: 'https://www.hyundaicard.com', pathname: '/', tables: [] }],
        failedFrames: 0,
        skippedFrames: 0
      }).issues
    ).toContain('no_tables')
  })
  it('rejects invalid data without echoing it in the error', () => {
    const input = page()
    input.frames[0].origin = 'https://evil.test/private'
    expect(() => new FinanceCaptureStore().save(input)).toThrow('finance_capture_invalid')
  })
  it('enforces the single-capture byte limit', () => {
    const input = page()
    input.frames[0].tables[0].rows = Array.from({ length: 600 }, () => [
      { text: 'x'.repeat(1800), header: false, rowSpan: 1, colSpan: 1 }
    ])
    expect(() => new FinanceCaptureStore().save(input)).toThrow('finance_capture_limit')
  })
  it('evicts at the total byte bound before reaching the item bound', () => {
    const store = new FinanceCaptureStore()
    const input = page()
    input.frames[0].tables[0].rows = Array.from({ length: 500 }, () => [
      { text: 'x'.repeat(1800), header: false, rowSpan: 1, colSpan: 1 }
    ])
    const first = store.save(input)
    for (let i = 0; i < 4; i += 1) store.save(input)
    expect(store.readForReview(first.captureId)).toBeNull()
    store.clear()
  })
  it('clear removes captured financial text', () => {
    const store = new FinanceCaptureStore()
    const receipt = store.save(page())
    store.clear()
    expect(store.readForReview(receipt.captureId)).toBeNull()
  })
})
