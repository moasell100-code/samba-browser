import type { LotteHistoryLayout, LotteHistoryLayoutNode } from '../shared/lotte-history-layout'

const PATH = '/app/LPMCDAA_V100.lc'
const TAGS = new Set([
  'UL',
  'OL',
  'LI',
  'DIV',
  'SPAN',
  'STRONG',
  'EM',
  'B',
  'I',
  'SMALL',
  'P',
  'A',
  'DL',
  'DT',
  'DD',
  'TABLE',
  'THEAD',
  'TBODY',
  'TR',
  'TH',
  'TD',
  'BR'
])
// Fixed public component classes confirmed from the official stylesheet. Arbitrary attributes
// can contain approval/account IDs; never copy unknown class or id strings into diagnostics.
const CLASSES = new Set([
  'useCardList',
  'type02',
  'info',
  'toggle',
  'toggleON',
  'icoMore',
  'useList',
  'cancel',
  'parttot',
  'totLine2',
  'totLine3',
  'off',
  'btns',
  'linkArr',
  'part',
  'partcancel'
])
const LABELS = new Set([
  '승인일자',
  '승인번호',
  '이용일자',
  '이용금액',
  '가맹점명',
  '카드번호',
  '카드명',
  '취소일자',
  '취소금액',
  '취소여부',
  '결제일',
  '이용구분',
  '할부개월',
  '승인상태',
  '이용내역',
  '승인금액',
  '결제방법',
  '승인일시',
  '취소일시',
  '매입일자',
  '더보기'
])
const STATUS_LABELS = new Set(['취소', '부분취소', '승인취소'])

function visible(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (
      node.hasAttribute('hidden') ||
      node.hasAttribute('inert') ||
      node.getAttribute('aria-hidden') === 'true'
    )
      return false
    const style = node.ownerDocument.defaultView?.getComputedStyle(node)
    if (
      style?.display === 'none' ||
      style?.visibility === 'hidden' ||
      style?.visibility === 'collapse' ||
      style?.opacity === '0' ||
      style?.clip === 'rect(0px, 0px, 0px, 0px)'
    )
      return false
    if (
      style?.position === 'absolute' &&
      (parseFloat(style.left) <= -9999 || parseFloat(style.top) <= -9999)
    )
      return false
  }
  return true
}

function eligible(el: Element): boolean {
  return (
    TAGS.has(el.tagName) &&
    !el.closest('input,select,textarea,button,script,style,template,noscript,[contenteditable]') &&
    visible(el)
  )
}

function describe(el: Element, depth: number): LotteHistoryLayoutNode {
  const classes = Array.from(CLASSES).filter((name) => el.classList.contains(name))
  const id = el.id === 'useCardList' || el.id === 'aprUseSumList' ? el.id : undefined
  const children = Array.from(el.children).filter((child) =>
    el.tagName === 'BUTTON'
      ? TAGS.has(child.tagName) && !child.hasAttribute('contenteditable') && visible(child)
      : eligible(child)
  )
  const node: LotteHistoryLayoutNode = {
    depth,
    tag: el.tagName.toLowerCase(),
    classes,
    ...(id ? { id } : {}),
    omittedClasses: el.classList.length > classes.length,
    hasUnlistedId: el.hasAttribute('id') && !id,
    visibleChildCount: Math.min(children.length, 1000)
  }
  if (children.length === 0) {
    // Direct text nodes only, never hidden descendants, field values, or arbitrary attributes.
    let text = ''
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) text += (child.textContent ?? '').slice(0, 257)
      if (text.length > 256) break
    }
    const exactStatus = STATUS_LABELS.has(text.trim()) ? text.trim() : undefined
    text = text.replace(/\s+/g, '').trim()
    if (!text) node.textKind = 'empty'
    else if (exactStatus) {
      node.textKind = 'fixed_label'
      node.label = exactStatus
    } else if (LABELS.has(text)) {
      node.textKind = 'fixed_label'
      node.label = text
    } else if (
      /^(?:\d{2}|\d{4})[./-]\d{1,2}[./-]\d{1,2}(?:\.?|[T ]?\d{1,2}:\d{2}(?::\d{2})?)$/.test(text)
    )
      node.textKind = 'date_like'
    else if (/^(?:₩)?[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?(?:원)?$/.test(text))
      node.textKind = 'amount_like'
    else node.textKind = 'nonempty'
  }
  return node
}

function moreControls(root: Element): NonNullable<LotteHistoryLayout['moreControls']> {
  const scope = root.parentElement
  if (!scope) return []
  const matches: NonNullable<LotteHistoryLayout['moreControls']> = []
  // Only pagination's exact public label is compared. Other button text is never returned.
  for (const el of Array.from(scope.querySelectorAll('a,button')).slice(0, 200)) {
    if (
      !visible(el) ||
      el.closest('[contenteditable],input,select,textarea,script,style,template,noscript')
    )
      continue
    let text = ''
    let visited = 0
    const read = (node: Node): void => {
      if (++visited > 20 || text.length > 32) return
      if (node.nodeType === 3) {
        text += node.textContent ?? ''
        return
      }
      if (node.nodeType !== 1) return
      const child = node as Element
      if (
        !visible(child) ||
        /^(INPUT|SELECT|TEXTAREA|SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(child.tagName) ||
        child.hasAttribute('contenteditable')
      )
        return
      for (const descendant of Array.from(child.childNodes)) read(descendant)
    }
    read(el)
    if (visited > 20 || text.replace(/\s+/g, '') !== '더보기') continue
    const path: number[] = []
    let current: Element | null = el
    while (current && current !== scope && path.length <= 6) {
      const parent = current.parentElement
      if (!parent) break
      path.unshift(Array.from(parent.children).indexOf(current) + 1)
      current = parent
    }
    if (current !== scope || path.length > 6 || path.some((index) => index > 1000)) continue
    const node = describe(el, 0)
    node.textKind = 'fixed_label'
    node.label = '더보기'
    matches.push({ path, node })
    if (matches.length >= 3) break
  }
  return matches
}

function rowShape(row: Element): { nodes: LotteHistoryLayoutNode[]; truncated: boolean } {
  const shape = { nodes: [] as LotteHistoryLayoutNode[], truncated: false }
  const visit = (el: Element, depth: number): void => {
    if (!eligible(el)) return
    if (depth > 6 || shape.nodes.length >= 80) {
      shape.truncated = true
      return
    }
    shape.nodes.push(describe(el, depth))
    for (const child of Array.from(el.children)) {
      visit(child, depth + 1)
      if (shape.nodes.length >= 80) {
        shape.truncated = true
        break
      }
    }
  }
  visit(row, 0)
  return shape
}

export function readLotteHistoryLayout(doc: Document = document): LotteHistoryLayout {
  let url: URL
  try {
    url = new URL(doc.URL)
  } catch {
    return { state: 'unsupported' }
  }
  if (
    url.origin !== 'https://www.lottecard.co.kr' ||
    url.username ||
    url.password ||
    url.pathname !== PATH ||
    !doc.defaultView ||
    doc.defaultView.self !== doc.defaultView.top
  )
    return { state: 'unsupported' }
  const roots = Array.from(doc.querySelectorAll('#useCardList')).filter(eligible)
  if (!roots.length) return { state: 'root_missing' }
  if (roots.length !== 1) return { state: 'root_ambiguous' }
  const root = roots[0]
  const sourceRows = Array.from(root.children).filter((el) => el.tagName === 'LI')
  const rows = sourceRows.filter(eligible)
  const result: LotteHistoryLayout = {
    state: 'ok',
    directRowCount: Math.min(rows.length, 1000),
    root: describe(root, 0),
    representative: [],
    variantSamples: [],
    variants: { cancel: 0, parttot: 0, toggle: 0, toggleON: 0 },
    moreControls: moreControls(root),
    truncated: rows.length > 1000
  }
  for (const row of rows.slice(0, 1000)) {
    for (const name of ['toggle', 'toggleON'] as const)
      if (row.classList.contains(name)) result.variants![name]++
    for (const name of ['cancel', 'parttot'] as const) {
      if (
        Array.from(row.children).some(
          (el) => el.tagName === 'EM' && eligible(el) && el.classList.contains(name)
        )
      )
        result.variants![name]++
    }
  }
  if (rows[0]) {
    const first = rowShape(rows[0])
    result.representative = first.nodes
    result.truncated ||= first.truncated
  }
  const hasAmountClass = (row: Element, name: string): boolean =>
    Array.from(row.children).some(
      (el) => el.tagName === 'EM' && eligible(el) && el.classList.contains(name)
    )
  const variants: Array<
    [
      NonNullable<LotteHistoryLayout['variantSamples']>[number]['variant'],
      (row: Element) => boolean
    ]
  > = [
    ['row_cancel', (row) => row.classList.contains('cancel')],
    ['em_cancel', (row) => hasAmountClass(row, 'cancel')],
    ['em_parttot', (row) => hasAmountClass(row, 'parttot')],
    [
      'normal',
      (row) =>
        !row.classList.contains('cancel') &&
        !hasAmountClass(row, 'cancel') &&
        !hasAmountClass(row, 'parttot')
    ]
  ]
  const selected = new Set(rows[0] ? [rows[0]] : [])
  for (const [variant, matches] of variants) {
    if (result.variantSamples!.length >= 3) break
    const rowIndex = sourceRows.slice(0, 1000).findIndex((row) => eligible(row) && matches(row))
    if (rowIndex < 0 || selected.has(sourceRows[rowIndex])) continue
    selected.add(sourceRows[rowIndex])
    const shape = rowShape(sourceRows[rowIndex])
    result.variantSamples!.push({ variant, rowIndex, ...shape })
    result.truncated ||= shape.truncated
  }
  result.truncated ||= sourceRows.length > 1000
  return result
}
