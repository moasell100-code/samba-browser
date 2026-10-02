import { parse, type HTMLElement, type Node } from 'node-html-parser'

export interface LotteHistoryContentSummary {
  format: 'html' | 'other'
  root: 'full' | 'fragment' | 'empty' | 'unrecognized'
  rowCount: number | null
}

const MAX_BYTES = 2 * 1024 * 1024
const MAX_ROWS = 1000
const MAX_NODES = 20_000
const MAX_DEPTH = 30

function elements(node: Node): HTMLElement[] {
  return node.childNodes.filter((child): child is HTMLElement => child.nodeType === 1)
}

function bounded(root: HTMLElement): boolean {
  const pending: Array<{ node: Node; depth: number }> = [{ node: root, depth: 0 }]
  let visited = 0
  while (pending.length) {
    const current = pending.pop()!
    if (++visited > MAX_NODES || current.depth > MAX_DEPTH) return false
    for (const child of current.node.childNodes)
      pending.push({ node: child, depth: current.depth + 1 })
  }
  return true
}

function unavailable(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentNode) {
    if (
      ['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'TEXTAREA'].includes(node.tagName) ||
      node.hasAttribute('hidden') ||
      node.hasAttribute('inert') ||
      node.getAttribute('aria-hidden') === 'true' ||
      /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!important\s*)?(?:;|$)/i.test(
        node.getAttribute('style') ?? ''
      )
    )
      return true
  }
  return false
}

function hasOnlyRows(container: HTMLElement, rows: HTMLElement[]): boolean {
  return (
    rows.length <= MAX_ROWS &&
    container.childNodes.every(
      (node) =>
        node.nodeType === 8 ||
        (node.nodeType === 3 && !node.rawText.trim()) ||
        (node.nodeType === 1 && (node as HTMLElement).tagName === 'LI')
    )
  )
}

/** Structure only: do not read transaction text, attributes containing values, or detail rows. */
function transactionRow(row: HTMLElement, fragment: boolean): boolean {
  if (row.tagName !== 'LI' || unavailable(row)) return false
  if (fragment && !row.classList.contains('toggle') && !row.classList.contains('toggleON'))
    return false
  const children = elements(row)
  const names = children.filter((child) => child.tagName === 'STRONG')
  const info = children.filter(
    (child) => child.tagName === 'DIV' && child.classList.contains('info')
  )
  const amounts = children.filter((child) => child.tagName === 'EM')
  if (names.length !== 1 || info.length !== 1 || amounts.length !== 1) return false
  if ([names[0], info[0], amounts[0]].some(unavailable)) return false
  const metadata = elements(info[0])
  const values = elements(amounts[0])
  if ([...metadata, ...values].some((node) => node.tagName !== 'SPAN' || unavailable(node)))
    return false
  if (amounts[0].classList.contains('cancel')) return false
  const cancelled = row.classList.contains('cancel')
  const partial = amounts[0].classList.contains('parttot')
  if (cancelled || partial) {
    return (
      metadata.length === 4 &&
      ((cancelled && !partial && amounts[0].classList.length === 0 && values.length === 1) ||
        (!cancelled && partial && amounts[0].classList.length === 1 && values.length === 2))
    )
  }
  return metadata.length === 3 && values.length === 1
}

/** The official eiwaf envelope inserts Content as HTML. Parsing here never executes or loads it. */
export function summarizeLotteHistoryContent(parsed: unknown): LotteHistoryContentSummary {
  const other: LotteHistoryContentSummary = {
    format: 'other',
    root: 'unrecognized',
    rowCount: null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return other
  const content: unknown = Object.getOwnPropertyDescriptor(parsed, 'Content')?.value
  if (typeof content !== 'string') return other
  const unknown: LotteHistoryContentSummary = {
    format: 'html',
    root: 'unrecognized',
    rowCount: null
  }
  if (content.length > MAX_BYTES || Buffer.byteLength(content, 'utf8') > MAX_BYTES) return unknown
  try {
    const doc = parse(content, {
      comment: true,
      blockTextElements: { script: true, style: true, pre: true }
    })
    if (!bounded(doc)) return unknown
    const top = elements(doc)
    if (
      top.length === 1 &&
      top[0].tagName === 'LI' &&
      top[0].classList.contains('noData') &&
      top[0].classList.length === 1 &&
      Object.keys(top[0].attributes).every((name) => name === 'class') &&
      !unavailable(top[0]) &&
      elements(top[0]).length === 0 &&
      doc.childNodes.every(
        (node) =>
          node.nodeType === 8 || node === top[0] || (node.nodeType === 3 && !node.text.trim())
      ) &&
      [
        '조회하신조건에맞는내역이없습니다.',
        '조회하신조건과일치하는내역이없습니다.',
        '조회하신조건에해당하는내역이없습니다.',
        '조회하신이용내역이없습니다.',
        '조회된이용내역이없습니다.',
        '조회된내역이없습니다.',
        '조회내역이없습니다.',
        '이용내역이없습니다.'
      ].includes(top[0].text.replace(/\s+/g, ''))
    )
      return { format: 'html', root: 'empty', rowCount: 0 }
    const candidates = doc.querySelectorAll('#useCardList')
    if (candidates.length) {
      if (candidates.length !== 1) return unknown
      const root = candidates[0]
      if (
        root.tagName !== 'UL' ||
        !root.classList.contains('useCardList') ||
        !root.classList.contains('type02') ||
        unavailable(root)
      )
        return unknown
      const rows = elements(root)
      if (!hasOnlyRows(root, rows) || !rows.every((row) => transactionRow(row, false)))
        return unknown
      return { format: 'html', root: 'full', rowCount: rows.length }
    }
    const rows = elements(doc)
    if (!rows.length || !hasOnlyRows(doc, rows) || !rows.every((row) => transactionRow(row, true)))
      return unknown
    return { format: 'html', root: 'fragment', rowCount: rows.length }
  } catch {
    return unknown
  }
}
