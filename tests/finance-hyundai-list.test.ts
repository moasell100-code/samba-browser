import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { captureHyundaiHistoryLists } from '../src/preload/page-finance-hyundai'
import { captureFinanceTables } from '../src/preload/page-finance'
import { FinanceCaptureStore } from '../src/main/finance/capture-store'
import type { FinanceCaptureReceipt } from '../src/shared/finance-capture'

const HISTORY_URL = 'https://www.hyundaicard.com/cpa/cb/CPACB0101_01.hc'
const windows: JSDOM[] = []
function docAt(html: string, url = HISTORY_URL): Document {
  const dom = new JSDOM(html, { url })
  windows.push(dom)
  return dom.window.document
}
afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close()
})

// Synthetic text only, using the authenticated page's observed DOM boundaries.
function row(): string {
  return `<div class="cel_list"><a class="cel_link" href="?private-query" onclick="private-handler">
    <span class="p1_m_lt_1ln">합성상점</span>
    <span class="divr_dot">
      <li class="p2_m_lt_1ln divr_txt">합성카드</li>
      <li class="p2_m_lt_1ln divr_txt">어제</li>
      <li class="p2_m_lt_1ln divr_txt">12:34</li>
      <li class="p2_m_lt_1ln divr_txt">일시불 취소</li>
    </span><span class="price"><em class="p1_m_rt_1ln">-12,345원</em></span>
  </a><div hidden>hidden-details-secret</div><input value="input-secret"></div>`
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
function root(rows: string): string {
  return `<form><div id="divHistoryUseRight"><div>${rows}</div></div></form>`
}

function receipt(html: string): FinanceCaptureReceipt {
  const frame = captureFinanceTables(docAt(html))
  const store = new FinanceCaptureStore()
  try {
    return store.save({ frames: [frame], failedFrames: 0, skippedFrames: 0 })
  } finally {
    store.clear()
  }
}

function total(count: number): string {
  return `<div class="cel_total"><div class="box_info01 clearfix"><div class="fl">
    <p class="p1_m_lt_1ln">총 ${count}건</p></div><div class="fr">
    <p class="p1_m_rt_1ln">999,888,777원</p></div></div></div>`
}

describe('Hyundai observed visible list adapter', () => {
  it('keeps raw fields local and returns only verified column counts to the model', () => {
    const result = receipt(root(row()))
    expect(result.issuer).toBe('hyundai_card')
    expect(result.listRowCount).toBe(1)
    expect(result.listSummaries).toEqual([
      {
        adapter: 'hyundai_history_list_v1',
        rowCount: 1,
        detailsVisibleCount: 0,
        sourceRowIdCount: 0,
        duplicateVisibleRowCount: 0,
        nonemptyFields: ['name', 'card', 'date', 'time', 'payment_type', 'amount'].map((field) => ({
          field,
          count: 1
        }))
      }
    ])
    expect(JSON.stringify(result)).not.toMatch(/합성|어제|12:34|취소|12,345|secret|private/)
    expect(result.issues).toContain('details_incomplete')
    expect(result.previewOnly).toBe(true)
  })

  it('compares the displayed left count with captured rows without returning the right amount', () => {
    const result = receipt(
      root(row()).replace(
        '<div id="divHistoryUseRight">',
        `<div id="divHistoryUseRight">${total(700)}`
      )
    )
    expect(result.listSummaries![0].displayedTotal).toBe(700)
    expect(result.listRowCount).toBe(1)
    expect(result.issues).toContain('total_count_mismatch')
    expect(JSON.stringify(result)).not.toContain('999,888,777')
  })

  it('does not report a count mismatch when displayed count and captured rows agree', () => {
    const result = receipt(
      root(row()).replace(
        '<div id="divHistoryUseRight">',
        `<div id="divHistoryUseRight">${total(1)}`
      )
    )
    expect(result.listSummaries![0].displayedTotal).toBe(1)
    expect(result.issues).not.toContain('total_count_mismatch')
    expect(result.issues).toContain('pagination_unverified')
  })

  it('preserves six visible column boundaries, relative dates and combined status without inventing IDs', () => {
    const read = readers()
    const result = captureHyundaiHistoryLists(docAt(root(row())), read)
    expect(result).toEqual([
      {
        adapter: 'hyundai_history_list_v1',
        hiddenRows: 0,
        unrecognizedRows: 0,
        hasMore: false,
        rows: [
          {
            head: [
              { field: 'name', text: '합성상점' },
              { field: 'card', text: '합성카드' },
              { field: 'date', text: '어제' },
              { field: 'time', text: '12:34' },
              { field: 'payment_type', text: '일시불 취소' },
              { field: 'amount', text: '-12,345원' }
            ],
            details: [],
            detailsVisible: false
          }
        ]
      }
    ])
    expect(read.countRow).toHaveBeenCalledExactlyOnceWith(6)
    expect(read.readCell).toHaveBeenCalledTimes(6)
    expect(JSON.stringify(result)).not.toMatch(/private|secret|sourceRowId/)
  })

  it.each([
    'http://www.hyundaicard.com/cpa/cb/CPACB0101_01.hc',
    'https://www.hyundaicard.com.evil.test/cpa/cb/CPACB0101_01.hc',
    'https://www.samsungcard.com/cpa/cb/CPACB0101_01.hc',
    'https://www.hyundaicard.com:8443/cpa/cb/CPACB0101_01.hc',
    'https://user@www.hyundaicard.com/cpa/cb/CPACB0101_01.hc',
    'https://www.hyundaicard.com/cpa/cb/CPACB0101_05.hc'
  ])('does not inspect fields outside the exact approved history page %s', (url) => {
    const read = readers()
    expect(captureHyundaiHistoryLists(docAt(root(row()), url), read)).toEqual([])
    expect(read.readCell).not.toHaveBeenCalled()
  })

  it('reports hidden rows and malformed metadata instead of combining or fabricating cells', () => {
    const hidden = row().replace('class="cel_list"', 'class="cel_list" hidden')
    const malformed = row().replace('<li class="p2_m_lt_1ln divr_txt">일시불 취소</li>', '')
    const read = readers()
    const result = captureHyundaiHistoryLists(docAt(root(hidden + malformed)), read)
    expect(result[0]).toMatchObject({ rows: [], hiddenRows: 1, unrecognizedRows: 1 })
    expect(result[0].unrecognizedDiagnostics).toEqual([
      {
        rowIndex: 1,
        reason: 'field_count',
        linkCount: 1,
        nameCount: 1,
        metadataCount: 3,
        amountCount: 1
      }
    ])
    expect(read.readCell).not.toHaveBeenCalled()
  })

  it('retains the verified row with a fifth textless metadata cell without inventing a status', () => {
    const trailingEmpty = row().replace(
      '</span><span class="price">',
      '<li class="p2_m_lt_1ln divr_txt"> </li></span><span class="price">'
    )
    const frame = captureFinanceTables(docAt(root(trailingEmpty)))
    expect(frame.lists![0].rows).toEqual(captureFinanceTables(docAt(root(row()))).lists![0].rows)
    expect(frame.lists![0].unrecognizedRows).toBe(0)
    expect(frame.lists![0].unrecognizedDiagnostics).toBeUndefined()
    const report = receipt(root(trailingEmpty))
    expect(report.listRowCount).toBe(1)
    expect(report.issues).toContain('details_incomplete')
    expect(report.issues).not.toContain('unrecognized_rows')
  })

  it('continues to reject a nonempty fifth metadata cell or more than five cells', () => {
    for (const extra of [
      '<li class="p2_m_lt_1ln divr_txt">unknown-status-fixture</li>',
      '<li class="p2_m_lt_1ln divr_txt"></li><li class="p2_m_lt_1ln divr_txt"></li>'
    ]) {
      const html = root(
        row().replace('</span><span class="price">', `${extra}</span><span class="price">`)
      )
      const frame = captureFinanceTables(docAt(html))
      expect(frame.lists![0].rows).toEqual([])
      expect(frame.lists![0].unrecognizedRows).toBe(1)
      expect(frame.lists![0].unrecognizedDiagnostics![0].reason).toBe('field_count')
      expect(JSON.stringify(receipt(html))).not.toContain('unknown-status-fixture')
    }
  })

  it('does not read hidden or duplicate roots, hidden fields, or ambiguous links', () => {
    for (const html of [
      root(row()).replace('id="divHistoryUseRight"', 'id="divHistoryUseRight" hidden'),
      root(row()) + root(row())
    ]) {
      const read = readers()
      expect(captureHyundaiHistoryLists(docAt(html), read)).toEqual([])
      expect(read.readCell).not.toHaveBeenCalled()
    }
    const hiddenField = row().replace('class="price"', 'class="price" hidden')
    const duplicate = row().replace('</a>', '</a><a class="cel_link">unrelated</a>')
    const read = readers()
    const result = captureHyundaiHistoryLists(docAt(root(hiddenField + duplicate)), read)
    expect(result[0].unrecognizedRows).toBe(2)
    expect(result[0].unrecognizedDiagnostics).toEqual([
      {
        rowIndex: 0,
        reason: 'field_count',
        linkCount: 1,
        nameCount: 1,
        metadataCount: 4,
        amountCount: 0
      },
      { rowIndex: 1, reason: 'link_count', linkCount: 2 }
    ])
    expect(read.readCell).not.toHaveBeenCalled()
  })

  it('reports at most five omitted-row diagnostics using counts and empty field names only', () => {
    const blankTime = row().replace('12:34', '')
    const read = readers()
    const result = captureHyundaiHistoryLists(docAt(root(blankTime.repeat(8))), read)
    expect(result[0].unrecognizedRows).toBe(8)
    expect(result[0].unrecognizedDiagnostics).toHaveLength(5)
    expect(result[0].unrecognizedDiagnostics![4]).toEqual({
      rowIndex: 4,
      reason: 'empty_fields',
      linkCount: 1,
      nameCount: 1,
      metadataCount: 4,
      amountCount: 1,
      emptyFields: ['time']
    })
    const diagnostics = JSON.stringify(result[0].unrecognizedDiagnostics)
    expect(diagnostics).not.toMatch(/합성|어제|취소|12,345|secret|private/)
    const report = receipt(root(blankTime.repeat(8)))
    expect(report.listSummaries![0].unrecognizedDiagnostics).toEqual(
      result[0].unrecognizedDiagnostics
    )
    expect(report.issues).toContain('unrecognized_rows')
    expect(JSON.stringify(report)).not.toMatch(/합성|어제|취소|12,345|secret|private/)
  })

  it('propagates the shared capture budget and bounds malformed row scanning', () => {
    const read = readers()
    read.countRow.mockImplementation(() => {
      throw new Error('finance_capture_limit')
    })
    expect(() => captureHyundaiHistoryLists(docAt(root(row())), read)).toThrow(
      'finance_capture_limit'
    )
    expect(read.readCell).not.toHaveBeenCalled()
    expect(() =>
      captureHyundaiHistoryLists(
        docAt(root('<div class="cel_list"></div>'.repeat(1001))),
        readers()
      )
    ).toThrow('finance_capture_limit')
  })
})
