import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { captureHyundaiHistoryLists } from '../src/preload/page-finance-hyundai'

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

describe('Hyundai observed visible list adapter', () => {
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
    expect(read.readCell).not.toHaveBeenCalled()
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
    expect(read.readCell).not.toHaveBeenCalled()
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
