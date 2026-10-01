import type { FinanceListCapture, FinanceListRow } from '../shared/finance-capture'

interface HyundaiHistoryReaders {
  isHidden: (element: Element) => boolean
  readCell: (element: Element) => string
  countRow: (columns: number) => void
}

const HISTORY_PATH = '/cpa/cb/CPACB0101_01.hc'
const MAX_ROWS = 1000

/**
 * Observed Hyundai recent-usage DOM boundaries. Preserve relative dates and
 * the site's combined payment-type/cancellation text without interpretation.
 * Never inspect link attributes, event handlers, page state, or hidden details.
 */
export function captureHyundaiHistoryLists(
  doc: Document,
  readers: HyundaiHistoryReaders
): FinanceListCapture[] {
  let url: URL
  try {
    url = new URL(doc.URL)
  } catch {
    return []
  }
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    !['hyundaicard.com', 'www.hyundaicard.com'].includes(url.hostname) ||
    url.pathname !== HISTORY_PATH
  ) {
    return []
  }
  const roots = Array.from(doc.querySelectorAll('div#divHistoryUseRight')).filter(
    (root) => !readers.isHidden(root)
  )
  if (roots.length !== 1) return []
  const root = roots[0]
  const sourceRows = Array.from(root.querySelectorAll(':scope > div > div.cel_list'))
  if (!sourceRows.length) return []
  if (sourceRows.length > MAX_ROWS) throw new Error('finance_capture_limit')
  const result: FinanceListCapture = {
    adapter: 'hyundai_history_list_v1',
    rows: [],
    hiddenRows: 0,
    unrecognizedRows: 0,
    // Pagination has not been verified. This flag does not assert completeness;
    // the shared receipt retains pagination_unverified for this preview.
    hasMore: false
  }
  const visibleMatches = (parent: Element, selector: string): Element[] =>
    Array.from(parent.querySelectorAll(selector)).filter((element) => !readers.isHidden(element))
  const recordUnrecognized = (
    diagnostic: NonNullable<FinanceListCapture['unrecognizedDiagnostics']>[number]
  ): void => {
    result.unrecognizedRows += 1
    if ((result.unrecognizedDiagnostics?.length ?? 0) >= 5) return
    ;(result.unrecognizedDiagnostics ??= []).push(diagnostic)
  }

  for (const [rowIndex, row] of sourceRows.entries()) {
    if (readers.isHidden(row)) {
      result.hiddenRows += 1
      continue
    }
    const links = visibleMatches(row, ':scope > a.cel_link')
    if (links.length > MAX_ROWS) throw new Error('finance_capture_limit')
    if (links.length !== 1) {
      recordUnrecognized({ rowIndex, reason: 'link_count', linkCount: links.length })
      continue
    }
    const link = links[0]
    const name = visibleMatches(link, ':scope > span.p1_m_lt_1ln')
    const metadata = visibleMatches(link, ':scope > span.divr_dot > li.p2_m_lt_1ln.divr_txt')
    const amount = visibleMatches(link, ':scope > span.price > em.p1_m_rt_1ln')
    if ([name.length, metadata.length, amount.length].some((count) => count > MAX_ROWS))
      throw new Error('finance_capture_limit')
    const counts = {
      rowIndex,
      linkCount: links.length,
      nameCount: name.length,
      metadataCount: metadata.length,
      amountCount: amount.length
    }
    if (name.length !== 1 || metadata.length !== 4 || amount.length !== 1) {
      recordUnrecognized({ ...counts, reason: 'field_count' })
      continue
    }
    readers.countRow(6)
    const fields: FinanceListRow['head'][number]['field'][] = [
      'name',
      'card',
      'date',
      'time',
      'payment_type',
      'amount'
    ]
    const head = [name[0], ...metadata, amount[0]].map((element, index) => ({
      field: fields[index],
      text: readers.readCell(element)
    }))
    const emptyFields = head.filter(({ text }) => !text).map(({ field }) => field)
    if (emptyFields.length) {
      recordUnrecognized({ ...counts, reason: 'empty_fields', emptyFields })
      continue
    }
    result.rows.push({ head, details: [], detailsVisible: false })
  }
  return [result]
}
