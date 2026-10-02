import type { FinanceListCapture, FinanceListRow } from '../shared/finance-capture'

interface LotteHistoryReaders {
  isHidden: (element: Element) => boolean
  readCell: (element: Element) => string
  countRow: (columns: number) => void
}

const HISTORY_PATH = '/app/LPMCDAA_V100.lc'
const MAX_ROWS = 1000

/**
 * Read only the verified Lotte history list's displayed column boundaries.
 * The heading is a neutral name, not an inferred merchant or transaction ID.
 * Cancellation/partial-cancellation variants need separate shape verification.
 */
export function captureLotteHistoryLists(
  doc: Document,
  readers: LotteHistoryReaders
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
    url.hostname !== 'www.lottecard.co.kr' ||
    url.pathname !== HISTORY_PATH
  ) {
    return []
  }
  const roots = Array.from(doc.querySelectorAll('#useCardList.useCardList.type02')).filter(
    (element) => !readers.isHidden(element)
  )
  if (roots.length !== 1) return []
  const sourceRows = Array.from(roots[0].querySelectorAll(':scope > li'))
  if (!sourceRows.length) return []
  if (sourceRows.length > MAX_ROWS) throw new Error('finance_capture_limit')

  const result: FinanceListCapture = {
    adapter: 'lotte_history_list_v1',
    rows: [],
    hiddenRows: 0,
    unrecognizedRows: 0,
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
  // Only a displayed, exactly labelled control in this list's local container
  // establishes more rows. Its absence still does not establish completeness.
  const pagingControls = roots[0].parentElement
    ? visibleMatches(roots[0].parentElement, 'button, a')
    : []
  if (pagingControls.length > MAX_ROWS) throw new Error('finance_capture_limit')
  result.hasMore = pagingControls.some((element) => readers.readCell(element) === '더보기')

  for (const [rowIndex, row] of sourceRows.entries()) {
    if (readers.isHidden(row)) {
      result.hiddenRows += 1
      continue
    }
    const name = visibleMatches(row, ':scope > strong')
    const metadata = visibleMatches(row, '.info > span')
    const amounts = visibleMatches(row, ':scope > em')
    const amount = amounts.flatMap((element) => visibleMatches(element, ':scope > span'))
    if (
      [name.length, metadata.length, amounts.length, amount.length].some(
        (count) => count > MAX_ROWS
      )
    )
      throw new Error('finance_capture_limit')
    const counts = {
      rowIndex,
      linkCount: 0,
      nameCount: name.length,
      metadataCount: metadata.length,
      amountCount: amount.length
    }
    if (row.matches('.cancel') || amounts.some((element) => element.matches('.cancel, .parttot'))) {
      recordUnrecognized({ ...counts, reason: 'unsupported_variant' })
      continue
    }
    if (name.length !== 1 || metadata.length !== 3 || amounts.length !== 1 || amount.length !== 1) {
      recordUnrecognized({ ...counts, reason: 'field_count' })
      continue
    }
    readers.countRow(5)
    const fields: FinanceListRow['head'][number]['field'][] = [
      'name',
      'date',
      'card',
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
