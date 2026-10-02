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
function cancelledRow(): string {
  return row()
    .replace('class="toggle"', 'class="toggle cancel"')
    .replace('<span>일시불</span>', '<span>일시불</span><span>취소</span>')
}
function partialRow(): string {
  return row()
    .replace('<span>일시불</span>', '<span>일시불</span><span>부분취소</span>')
    .replace(
      '<em><span>-12,345원</span></em>',
      '<em class="parttot"><span>12,345원</span><span>6,789원</span></em>'
    )
}
function details(): string {
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
  return `<div class="useList"><ul>${labels
    .map(
      (label, index) =>
        `<li>${label}<input type="hidden" value="hidden-detail-secret"><span>${index === 2 ? 'SYNTH-98765' : `synthetic-value-${index}`}</span></li>`
    )
    .join('')}</ul></div>`
}
function withDetails(html: string, detail = details()): string {
  return html.replace(
    '<div class="useList" hidden><span>hidden-details-secret</span></div>',
    detail
  )
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

  it('retains the verified cancellation status and one displayed amount without netting it', () => {
    const read = readers()
    const result = captureLotteHistoryLists(docAt(root(cancelledRow())), read)[0]
    expect(result.unrecognizedRows).toBe(0)
    expect(result.rows[0]).toEqual({
      head: [
        { field: 'name', text: '합성표제' },
        { field: 'date', text: '2026.09.17' },
        { field: 'card', text: '합성카드(1234)' },
        { field: 'payment_type', text: '일시불' },
        { field: 'cancellation_status', text: '취소' },
        { field: 'amount', text: '-12,345원' }
      ],
      details: [],
      detailsVisible: false
    })
    expect(read.countRow).toHaveBeenCalledExactlyOnceWith(6)
  })

  it('preserves both partial-cancellation amount cells in visible order without assigning meaning', () => {
    const read = readers()
    const result = captureLotteHistoryLists(docAt(root(partialRow())), read)[0]
    expect(result.unrecognizedRows).toBe(0)
    expect(result.rows[0].head.map(({ field }) => field)).toEqual([
      'name',
      'date',
      'card',
      'payment_type',
      'cancellation_status',
      'amount',
      'secondary_amount'
    ])
    expect(result.rows[0].head.slice(4)).toEqual([
      { field: 'cancellation_status', text: '부분취소' },
      { field: 'amount', text: '12,345원' },
      { field: 'secondary_amount', text: '6,789원' }
    ])
    expect(read.countRow).toHaveBeenCalledExactlyOnceWith(7)
  })

  it.each(['부분취소(-1234원)', '부분취소(-1,234원)', '부분취소(-12,345,678원)'])(
    'preserves the verified amount-bearing partial-cancellation status %s without parsing it',
    (status) => {
      const result = captureLotteHistoryLists(
        docAt(root(partialRow().replace('부분취소', status))),
        readers()
      )[0]
      expect(result.unrecognizedRows).toBe(0)
      expect(result.rows[0].head.slice(4)).toEqual([
        { field: 'cancellation_status', text: status },
        { field: 'amount', text: '12,345원' },
        { field: 'secondary_amount', text: '6,789원' }
      ])
    }
  )

  it.each([
    '부분취소(1234원)',
    '부분취소(+1,234원)',
    '부분취소(-12,34원)',
    '부분취소(-1234,567원)',
    '부분취소(-1,234)',
    '부분취소 (-1,234원)',
    '부분취소(-1,234원) 기타'
  ])('does not broaden partial-cancellation recognition to an unverified label %s', (status) => {
    const result = captureLotteHistoryLists(
      docAt(root(partialRow().replace('부분취소', status))),
      readers()
    )[0]
    expect(result.rows).toEqual([])
    expect(result.unrecognizedRows).toBe(1)
    expect(result.unrecognizedDiagnostics![0].reason).toBe('unsupported_variant')
    expect(JSON.stringify(result.unrecognizedDiagnostics)).not.toContain(status)
  })

  it('requires the verified cancellation class, exact label and amount count together', () => {
    for (const html of [
      cancelledRow().replace('<span>취소</span>', '<span>부분취소</span>'),
      cancelledRow().replace('<em>', '<em class="cancel">'),
      cancelledRow().replace('<em>', '<em class="unknown">'),
      cancelledRow().replace('</em>', '<span>second-amount</span></em>'),
      partialRow().replace('<span>부분취소</span>', '<span>취소</span>'),
      partialRow().replace('class="toggle"', 'class="toggle cancel"'),
      partialRow().replace('class="parttot"', 'class="parttot cancel"'),
      partialRow().replace('class="parttot"', 'class="parttot unknown"'),
      partialRow().replace('<span>6,789원</span>', ''),
      partialRow().replace('</em>', '<span>third-amount</span></em>'),
      cancelledRow().replace('class="toggle cancel"', 'class="toggle"')
    ]) {
      const result = captureLotteHistoryLists(docAt(root(html)), readers())[0]
      expect(result.rows).toEqual([])
      expect(result.unrecognizedRows).toBe(1)
      expect(JSON.stringify(result.unrecognizedDiagnostics)).not.toMatch(/합성|12,345|취소/)
    }
  })

  it('captures only the exact expanded nine-label detail structure and its displayed approval ID', () => {
    const read = readers()
    const result = captureLotteHistoryLists(docAt(root(withDetails(partialRow()))), read)[0]
    expect(result.rows[0].details).toEqual([
      { label: '이용일시', value: 'synthetic-value-0' },
      { label: '거래유형', value: 'synthetic-value-1' },
      { label: '승인번호', value: 'SYNTH-98765' },
      { label: '취소여부', value: 'synthetic-value-3' },
      { label: '포인트사용', value: 'synthetic-value-4' },
      { label: '매입여부', value: 'synthetic-value-5' },
      { label: '취소금액', value: 'synthetic-value-6' },
      { label: '매입금액', value: 'synthetic-value-7' },
      { label: '취소일자', value: 'synthetic-value-8' }
    ])
    expect(result.rows[0].detailsVisible).toBe(true)
    expect(result.rows[0].sourceRowId).toBe('SYNTH-98765')
    expect(read.countRow).toHaveBeenCalledExactlyOnceWith(25)
    expect(JSON.stringify(result)).not.toMatch(/hidden-detail-secret|private-id/)
  })

  it('does not claim complete details or an approval ID for collapsed or unknown detail structures', () => {
    for (const detail of [
      details().replace('class="useList"', 'class="useList" hidden'),
      details().replace('승인번호', 'unknown-label'),
      details().replace('승인번호', '<b>승인번호</b>'),
      details().replace(
        '<span>SYNTH-98765</span>',
        '<span>SYNTH-98765</span><span>ambiguous</span>'
      ),
      details().replace('<span>SYNTH-98765</span>', '<span hidden>SYNTH-98765</span>'),
      details().replace('</ul>', '<li>extra<span>unknown-value</span></li></ul>'),
      details() + details()
    ]) {
      const result = captureLotteHistoryLists(
        docAt(root(withDetails(cancelledRow(), detail))),
        readers()
      )[0]
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].details).toEqual([])
      expect(result.rows[0].detailsVisible).toBe(false)
      expect(result.rows[0].sourceRowId).toBeUndefined()
    }
  })

  it('preserves an unparseable approval value locally without inventing sourceRowId', () => {
    for (const approval of ['---', 'SYNTH ID WITH SPACES', '']) {
      const result = captureLotteHistoryLists(
        docAt(root(withDetails(cancelledRow(), details().replace('SYNTH-98765', approval)))),
        readers()
      )[0]
      expect(result.rows[0].detailsVisible).toBe(true)
      expect(result.rows[0].sourceRowId).toBeUndefined()
    }
  })

  it('keeps a recognized head while leaving the unverified six-item detail variant incomplete', () => {
    const sixItemDetail = details()
      .replace(/<li>취소금액[\s\S]*<\/ul>/, '</ul>')
      .replace('포인트사용', '')
    const result = captureLotteHistoryLists(
      docAt(root(withDetails(cancelledRow(), sixItemDetail))),
      readers()
    )[0]
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].details).toEqual([])
    expect(result.rows[0].detailsVisible).toBe(false)
    expect(result.rows[0].sourceRowId).toBeUndefined()
  })

  it('keeps cancellation and expanded-detail values out of the model receipt', () => {
    const html = withDetails(
      partialRow(),
      details().replace(
        'synthetic-value-0',
        'synthetic-value-0<input value="nested-value-secret"><span hidden>nested-text-secret</span>'
      )
    )
    const frame = captureFinanceTables(docAt(root(html)))
    expect(frame.lists![0].rows[0].details[0].value).toBe('synthetic-value-0')
    const store = new FinanceCaptureStore()
    try {
      const result = store.save({ frames: [frame], failedFrames: 0, skippedFrames: 0 })
      expect(result.listRowCount).toBe(1)
      expect(result.listSummaries![0].detailsVisibleCount).toBe(1)
      expect(result.listSummaries![0].sourceRowIdCount).toBe(1)
      expect(result.listSummaries![0].nonemptyFields).toContainEqual({
        field: 'secondary_amount',
        count: 1
      })
      expect(result.issues).toContain('cancellation_amount_review')
      expect(JSON.stringify(result)).not.toMatch(/합성|SYNTH|synthetic|secret|12,345|6,789/)
    } finally {
      store.clear()
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
