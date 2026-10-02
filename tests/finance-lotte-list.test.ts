import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { captureLotteHistoryLists } from '../src/preload/page-finance-lotte'
import { captureFinanceTables } from '../src/preload/page-finance'
import { FinanceCaptureStore } from '../src/main/finance/capture-store'

const HISTORY_URL = 'https://www.lottecard.co.kr/app/LPMCDAA_V100.lc'
const windows: JSDOM[] = []
function docAt(html: string, url = HISTORY_URL): Document {
  const dom = new JSDOM(html, { url })
  windows.push(dom)
  return dom.window.document
}
afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close()
})

// Synthetic text only, following the authenticated screen's verified boundaries.
function row(): string {
  return `<li class="toggle" data-private-transaction="private-id"><strong>합성표제</strong>
    <div class="info"><span>2026.09.17</span><span>합성카드(1234)</span><span>일시불</span></div>
    <em><span>-12,345원</span></em>
    <div class="useList" hidden><span>hidden-details-secret</span></div>
    <input value="input-secret"><script>script-secret</script>
  </li>`
}
function root(rows: string, controls = ''): string {
  return `<section><ul id="useCardList" class="useCardList type02">${rows}</ul>${controls}</section>`
}
function isHidden(element: Element): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = current.ownerDocument.defaultView!.getComputedStyle(current)
    if (
      current.hasAttribute('hidden') ||
      current.getAttribute('aria-hidden') === 'true' ||
      style.display === 'none' ||
      style.visibility === 'hidden'
    )
      return true
  }
  return false
}
function readers(): {
  isHidden: typeof isHidden
  readCell: ReturnType<typeof vi.fn<(element: Element) => string>>
  countRow: ReturnType<typeof vi.fn<(columns: number) => void>>
} {
  return {
    isHidden,
    readCell: vi.fn((element: Element) => element.textContent?.trim() ?? ''),
    countRow: vi.fn<(columns: number) => void>()
  }
}

describe('Lotte observed visible history list adapter', () => {
  it('preserves five visible field boundaries without interpreting names or inventing IDs', () => {
    const read = readers()
    const result = captureLotteHistoryLists(docAt(root(row())), read)
    expect(result).toEqual([
      {
        adapter: 'lotte_history_list_v1',
        hiddenRows: 0,
        unrecognizedRows: 0,
        hasMore: false,
        rows: [
          {
            head: [
              { field: 'name', text: '합성표제' },
              { field: 'date', text: '2026.09.17' },
              { field: 'card', text: '합성카드(1234)' },
              { field: 'payment_type', text: '일시불' },
              { field: 'amount', text: '-12,345원' }
            ],
            details: [],
            detailsVisible: false
          }
        ]
      }
    ])
    expect(read.countRow).toHaveBeenCalledExactlyOnceWith(5)
    expect(read.readCell).toHaveBeenCalledTimes(5)
    expect(JSON.stringify(result)).not.toMatch(/private|secret|sourceRowId/)
  })

  it.each([
    'http://www.lottecard.co.kr/app/LPMCDAA_V100.lc',
    'https://www.lottecard.co.kr.evil.test/app/LPMCDAA_V100.lc',
    'https://lottecard.co.kr/app/LPMCDAA_V100.lc',
    'https://www.samsungcard.com/app/LPMCDAA_V100.lc',
    'https://www.lottecard.co.kr:8443/app/LPMCDAA_V100.lc',
    'https://user@www.lottecard.co.kr/app/LPMCDAA_V100.lc',
    'https://www.lottecard.co.kr/app/LPMANAA_V200.lc'
  ])('does not inspect rows outside the exact approved history page %s', (url) => {
    const read = readers()
    expect(captureLotteHistoryLists(docAt(root(row()), url), read)).toEqual([])
    expect(read.readCell).not.toHaveBeenCalled()
  })

  it('does not inspect hidden, duplicate, missing or unrelated roots', () => {
    for (const html of [
      root(row()).replace('id="useCardList"', 'id="useCardList" hidden'),
      root(row()) + root(row()),
      root(row()).replace('class="useCardList type02"', 'class="unrelated"'),
      root('')
    ]) {
      const read = readers()
      expect(captureLotteHistoryLists(docAt(html), read)).toEqual([])
      expect(read.readCell).not.toHaveBeenCalled()
    }
  })

  it('counts hidden and structurally unrecognized rows without combining amount cells', () => {
    const hidden = row().replace('class="toggle"', 'class="toggle" hidden')
    const malformed = row().replace('<span>일시불</span>', '')
    const multipleAmounts = row().replace('</em>', '<span>private-other-amount</span></em>')
    const read = readers()
    const result = captureLotteHistoryLists(
      docAt(root(hidden + malformed + multipleAmounts)),
      read
    )[0]
    expect(result).toMatchObject({ rows: [], hiddenRows: 1, unrecognizedRows: 2 })
    expect(result.unrecognizedDiagnostics).toEqual([
      {
        rowIndex: 1,
        reason: 'field_count',
        linkCount: 0,
        nameCount: 1,
        metadataCount: 2,
        amountCount: 1
      },
      {
        rowIndex: 2,
        reason: 'field_count',
        linkCount: 0,
        nameCount: 1,
        metadataCount: 3,
        amountCount: 2
      }
    ])
    expect(read.readCell).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('private-other-amount')
  })

  it('does not map unverified cancellation or partial-cancellation shapes as ordinary amounts', () => {
    for (const html of [
      row().replace('class="toggle"', 'class="toggle cancel"'),
      row().replace('<em>', '<em class="cancel">'),
      row().replace('<em>', '<em class="parttot">')
    ]) {
      const read = readers()
      const result = captureLotteHistoryLists(docAt(root(html)), read)[0]
      expect(result.rows).toEqual([])
      expect(result.unrecognizedRows).toBe(1)
      expect(result.unrecognizedDiagnostics![0].reason).toBe('unsupported_variant')
      expect(read.readCell).not.toHaveBeenCalled()
    }
  })

  it('reports only empty field names and the first five failed row positions', () => {
    const emptyName = row().replace('합성표제', '')
    const read = readers()
    const result = captureLotteHistoryLists(docAt(root(emptyName.repeat(7))), read)[0]
    expect(result.rows).toEqual([])
    expect(result.unrecognizedRows).toBe(7)
    expect(result.unrecognizedDiagnostics).toHaveLength(5)
    expect(result.unrecognizedDiagnostics![4]).toEqual({
      rowIndex: 4,
      reason: 'empty_fields',
      linkCount: 0,
      nameCount: 1,
      metadataCount: 3,
      amountCount: 1,
      emptyFields: ['name']
    })
    expect(JSON.stringify(result.unrecognizedDiagnostics)).not.toMatch(/2026|합성|1234|일시불/)
  })

  it('recognizes only an exact visible more control in the list container', () => {
    for (const [controls, hasMore] of [
      ['<button>더보기</button>', true],
      ['<a>더보기</a>', true],
      ['<button hidden>더보기</button>', false],
      ['<a aria-hidden="true">더보기</a>', false],
      ['<a>3개월까지 더보기</a>', false],
      ['<div>더보기</div>', false]
    ] as const) {
      expect(captureLotteHistoryLists(docAt(root(row(), controls)), readers())[0].hasMore).toBe(
        hasMore
      )
    }
    expect(
      captureLotteHistoryLists(docAt(`<button>더보기</button>${root(row())}`), readers())[0].hasMore
    ).toBe(false)
  })

  it('enforces row limits before reading financial cells and preserves shared budget failures', () => {
    const read = readers()
    expect(() => captureLotteHistoryLists(docAt(root('<li></li>'.repeat(1001))), read)).toThrow(
      'finance_capture_limit'
    )
    expect(read.readCell).not.toHaveBeenCalled()
    read.countRow.mockImplementation(() => {
      throw new Error('finance_capture_limit')
    })
    expect(() => captureLotteHistoryLists(docAt(root(row())), read)).toThrow(
      'finance_capture_limit'
    )
  })

  it('keeps raw cells local and reports only field counts with incomplete details', () => {
    const doc = docAt(
      root(
        row().replace(
          '합성표제',
          '합성표제<input value="nested-secret"><span hidden>nested-secret</span>'
        )
      )
    )
    const frame = captureFinanceTables(doc)
    expect(frame.lists![0].rows[0].head[0].text).toBe('합성표제')
    const store = new FinanceCaptureStore()
    try {
      const result = store.save({ frames: [frame], failedFrames: 0, skippedFrames: 0 })
      expect(result.issuer).toBe('lotte_card')
      expect(result.listRowCount).toBe(1)
      expect(result.listSummaries).toEqual([
        {
          adapter: 'lotte_history_list_v1',
          rowCount: 1,
          detailsVisibleCount: 0,
          sourceRowIdCount: 0,
          duplicateVisibleRowCount: 0,
          nonemptyFields: ['name', 'date', 'card', 'payment_type', 'amount'].map((field) => ({
            field,
            count: 1
          }))
        }
      ])
      expect(JSON.stringify(result)).not.toMatch(/합성|2026\.09\.17|일시불|12,345|secret|private/)
      expect(result.issues).toEqual(
        expect.arrayContaining([
          'details_incomplete',
          'pagination_unverified',
          'query_range_unverified'
        ])
      )
      expect(result.previewOnly).toBe(true)
    } finally {
      store.clear()
    }
  })
})
