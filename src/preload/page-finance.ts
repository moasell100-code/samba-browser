import type { FinanceFrameCapture, FinanceTableCell } from '../shared/finance-capture'

// Kept in preload so this does not introduce a shared runtime chunk.
export const FINANCE_CAPTURE_LIMITS = {
  tables: 20,
  rows: 1000,
  columns: 40,
  cells: 12000,
  cellChars: 2000,
  totalChars: 200000
} as const

function isHidden(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return true
    const style = node.ownerDocument.defaultView?.getComputedStyle(node)
    if (style?.display === 'none' || style?.visibility === 'hidden') return true
  }
  return false
}

// Text nodes only. Never read a form field's value, attributes, HTML, script or nested table.
function cellText(cell: Element): string {
  const parts: string[] = []
  let chars = 0
  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      const text = node.textContent || ''
      chars += text.length
      if (chars > FINANCE_CAPTURE_LIMITS.cellChars) throw new Error('finance_capture_limit')
      parts.push(text)
      return
    }
    if (node.nodeType !== 1) return
    const el = node as Element
    if (
      /^(INPUT|TEXTAREA|SELECT|SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TABLE)$/.test(el.tagName) ||
      el.hasAttribute('contenteditable') ||
      isHidden(el)
    )
      return
    for (const child of Array.from(el.childNodes)) visit(child)
  }
  for (const child of Array.from(cell.childNodes)) visit(child)
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/** Fixed DOM reader. It has no selectors, row data, or executable code supplied by a model. */
export function captureFinanceTables(doc: Document = document): FinanceFrameCapture {
  const url = new URL(doc.URL)
  if (
    url.protocol !== 'https:' ||
    !['hyundaicard.com', 'www.hyundaicard.com'].includes(url.hostname) ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  )
    throw new Error('finance_origin_not_allowed')

  const tables = Array.from(doc.querySelectorAll('table')).filter((table) => !isHidden(table))
  if (tables.length > FINANCE_CAPTURE_LIMITS.tables) throw new Error('finance_capture_limit')
  let rowCount = 0
  let cellCount = 0
  let totalChars = 0
  return {
    origin: url.origin,
    pathname: url.pathname,
    tables: tables.map((table, index) => {
      let hiddenRows = 0
      const rows: FinanceTableCell[][] = []
      for (const row of Array.from(table.rows)) {
        if (row.closest('table') !== table) continue
        if (isHidden(row)) {
          hiddenRows += 1
          continue
        }
        rowCount += 1
        if (
          rowCount > FINANCE_CAPTURE_LIMITS.rows ||
          row.cells.length > FINANCE_CAPTURE_LIMITS.columns
        ) {
          throw new Error('finance_capture_limit')
        }
        const cells = Array.from(row.cells).map((cell) => {
          cellCount += 1
          if (cellCount > FINANCE_CAPTURE_LIMITS.cells) throw new Error('finance_capture_limit')
          const text = isHidden(cell) ? '' : cellText(cell)
          totalChars += text.length
          if (totalChars > FINANCE_CAPTURE_LIMITS.totalChars)
            throw new Error('finance_capture_limit')
          return {
            text,
            header: cell.tagName === 'TH',
            rowSpan: cell.rowSpan,
            colSpan: cell.colSpan
          }
        })
        rows.push(cells)
      }
      return { index, rows, hiddenRows, hasNestedTable: table.querySelector('table') !== null }
    })
  }
}
