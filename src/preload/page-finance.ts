import type {
  FinanceFrameCapture,
  FinanceLayoutDiagnostic,
  FinanceListCapture,
  FinanceListRow,
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

interface CaptureBudget {
  rows: number
  cells: number
  chars: number
}

function readCell(el: Element, budget: CaptureBudget): string {
  budget.cells += 1
  if (budget.cells > FINANCE_CAPTURE_LIMITS.cells) throw new Error('finance_capture_limit')
  const text = isHidden(el) ? '' : cellText(el)
  budget.chars += text.length
  if (budget.chars > FINANCE_CAPTURE_LIMITS.totalChars) throw new Error('finance_capture_limit')
  return text
}

function countRow(budget: CaptureBudget, columns: number): void {
  budget.rows += 1
  if (budget.rows > FINANCE_CAPTURE_LIMITS.rows || columns > FINANCE_CAPTURE_LIMITS.columns)
    throw new Error('finance_capture_limit')
}

function visibleOne(root: Element, selector: string): Element | undefined {
  const matches = Array.from(root.querySelectorAll(selector)).filter((el) => !isHidden(el))
  return matches.length === 1 ? matches[0] : undefined
}

// These boundaries come from Samsung's public UHPPRP0801D0.jsp row template.
// Read only displayed head columns and expanded detail label/value pairs; never
// inspect the template, onclick data, hidden input values, or application state.
function samsungHistoryLists(doc: Document, url: URL, budget: CaptureBudget): FinanceListCapture[] {
  if (
    url.hostname !== 'www.samsungcard.com' ||
    ![
      '/personal/card/activity/UHPPRP0801M0.jsp',
      '/personal/card/activity/UHPPRP0801D0.jsp'
    ].includes(url.pathname)
  )
    return []
  const roots = Array.from(
    doc.querySelectorAll('ul#inquire_append, ul#clnd_inquire_append')
  ).filter((root) => !isHidden(root))
  const lists: FinanceListCapture[] = []
  for (const root of roots) {
    const sourceRows = Array.from(root.querySelectorAll(':scope > li.rowList'))
    if (!sourceRows.length) continue
    if (sourceRows.length > FINANCE_CAPTURE_LIMITS.rows) throw new Error('finance_capture_limit')
    const result: FinanceListCapture = {
      adapter: 'samsung_history_list_v1',
      rows: [],
      hiddenRows: 0,
      unrecognizedRows: 0,
      hasMore: false
    }
    const more = doc.getElementById(root.id === 'inquire_append' ? 'btn_more' : 'clnd_btn_more')
    result.hasMore = Boolean(more && !isHidden(more))
    for (const sourceRow of sourceRows) {
      if (isHidden(sourceRow)) {
        result.hiddenRows += 1
        continue
      }
      const selectors: Array<[FinanceListRow['head'][number]['field'], string]> = [
        ['name', ':scope > .head > .fl_l > p.name > span:not(.ico)'],
        ['date', ':scope > .head > .fl_l > p.td.first > strong'],
        ['time', ':scope > .head > .fl_l > p.td.second > span:not(.hide)'],
        ['card', ':scope > .head > .fl_l > p.td.last > span:first-child'],
        ['payment_type', ':scope > .head > .fl_l > p.td.last > span:last-child'],
        ['amount', ':scope > .head > .fl_r > p.em > strong']
      ]
      const head = selectors.map(([field, selector]) => ({
        field,
        el: visibleOne(sourceRow, selector)
      }))
      const cardColumns = sourceRow.querySelectorAll(':scope > .head > .fl_l > p.td.last > span')
      if (head.some(({ el }) => !el) || cardColumns.length !== 2) {
        result.unrecognizedRows += 1
        continue
      }
      const detail = visibleOne(sourceRow, ':scope > .desc_wrap.ui_accord_content')
      const pairs = detail
        ? Array.from(detail.querySelectorAll(':scope > ul.row > li')).filter(
            (pair) => !isHidden(pair)
          )
        : []
      const details: FinanceListRow['details'] = []
      let detailsVisible = Boolean(detail && pairs.length)
      for (const pair of pairs) {
        const label = visibleOne(pair, ':scope > .fl_l')
        const value = visibleOne(pair, ':scope > .fl_r')
        if (!label || !value) {
          detailsVisible = false
          continue
        }
        details.push({ label: readCell(label, budget), value: readCell(value, budget) })
      }
      countRow(budget, head.length + details.length * 2)
      const row: FinanceListRow = {
        head: head.map(({ field, el }) => ({ field, text: readCell(el!, budget) })),
        details,
        detailsVisible
      }
      const approval = details.filter(({ label }) => label === '승인번호')
      if (
        approval.length === 1 &&
        /^[A-Za-z0-9-]{1,80}$/.test(approval[0].value) &&
        !/^-+$/.test(approval[0].value)
      )
        row.sourceRowId = approval[0].value
      result.rows.push(row)
    }
    lists.push(result)
  }
  return lists
}

/** Fixed DOM reader. It has no selectors, row data, or executable code supplied by a model. */
export function captureFinanceTables(doc: Document = document): FinanceFrameCapture {
  const url = new URL(doc.URL)
  if (
    url.protocol !== 'https:' ||
    ![
      'hyundaicard.com',
      'www.hyundaicard.com',
      'www.samsungcard.com',
      'www.lottecard.co.kr'
    ].includes(url.hostname) ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  )
    throw new Error('finance_origin_not_allowed')

  const tables = Array.from(doc.querySelectorAll('table')).filter((table) => !isHidden(table))
  if (tables.length > FINANCE_CAPTURE_LIMITS.tables) throw new Error('finance_capture_limit')
  const budget: CaptureBudget = { rows: 0, cells: 0, chars: 0 }
  const lists = samsungHistoryLists(doc, url, budget)
  const layoutDiagnostic =
    tables.length === 0 &&
    ['hyundaicard.com', 'www.hyundaicard.com'].includes(url.hostname) &&
    url.pathname === HISTORY_PATH
      ? historyLayout(doc)
      : undefined
  return {
    origin: url.origin,
    pathname: url.pathname,
    ...(lists.length ? { lists } : {}),
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
        countRow(budget, row.cells.length)
        const cells = Array.from(row.cells).map((cell) => {
          const text = readCell(cell, budget)
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
