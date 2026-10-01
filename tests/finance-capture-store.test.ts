import { describe, expect, it, vi } from 'vitest'
import type { FinancePageCapture } from '../src/shared/finance-capture'
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
