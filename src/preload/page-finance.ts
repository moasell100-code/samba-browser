import type {
  FinanceFrameCapture,
  FinanceLayoutDiagnostic,
  FinanceTableCell
} from '../shared/finance-capture'

// Kept in preload so this does not introduce a shared runtime chunk.
export const FINANCE_CAPTURE_LIMITS = {
  tables: 20,
  rows: 1000,
  columns: 40,
  cells: 12000,
  cellChars: 2000,
  totalChars: 200000
} as const

const HISTORY_PATH = '/cpa/cb/CPACB0101_01.hc'
const LAYOUT_MAX_NODES = 80
const LAYOUT_MAX_DEPTH = 8
const LAYOUT_TAGS = new Set([
  'DIV',
  'SPAN',
  'UL',
  'OL',
  'LI',
  'DL',
  'DT',
  'DD',
  'P',
  'A',
  'STRONG',
  'EM',
  'B',
  'I',
  'SMALL',
  'SECTION',
  'ARTICLE',
  'HEADER',
  'FOOTER',
  'NAV',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BR',
  'HR',
  'IMG'
])

function isHidden(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return true
    const style = node.ownerDocument.defaultView?.getComputedStyle(node)
    if (style?.display === 'none' || style?.visibility === 'hidden') return true
  }
  return false
}

function historyLayout(doc: Document): FinanceLayoutDiagnostic | undefined {
  const root = doc.getElementById('divHistoryUseRight')
  if (
    !root ||
    root.closest('form, input, textarea, select, button, [contenteditable]') ||
    isHidden(root)
  )
    return undefined
  const diagnostic: FinanceLayoutDiagnostic = { nodes: [], truncated: false }
  const visit = (el: Element, depth: number): void => {
    // Reject the whole subtree, including controls' labels and fallback contents.
    if (!LAYOUT_TAGS.has(el.tagName) || el.hasAttribute('contenteditable') || isHidden(el)) return
    if (diagnostic.nodes.length >= LAYOUT_MAX_NODES || depth > LAYOUT_MAX_DEPTH) {
      diagnostic.truncated = true
      return
    }
    const classes = Array.from(el.classList).filter((name) =>
      /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name)
    )
    if (classes.length > 12) diagnostic.truncated = true
    diagnostic.nodes.push({ depth, tag: el.tagName.toLowerCase(), classes: classes.slice(0, 12) })
    for (const child of Array.from(el.children)) {
      visit(child, depth + 1)
      if (diagnostic.nodes.length >= LAYOUT_MAX_NODES) {
        diagnostic.truncated = true
        break
      }
    }
  }
  visit(root, 0)
  return diagnostic.nodes.length ? diagnostic : undefined
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
  const layoutDiagnostic =
    tables.length === 0 && url.pathname === HISTORY_PATH ? historyLayout(doc) : undefined
  return {
    origin: url.origin,
    pathname: url.pathname,
    ...(layoutDiagnostic ? { layoutDiagnostic } : {}),
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
