import type { FinanceListCapture, FinanceListRow } from '../shared/finance-capture'

interface LotteHistoryReaders {
  isHidden: (element: Element) => boolean
  readCell: (element: Element) => string
  countRow: (columns: number) => void
}

const HISTORY_PATH = '/app/LPMCDAA_V100.lc'
const MAX_ROWS = 1000
const DETAIL_LABELS = [
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

/**
 * Read only the verified Lotte history list's displayed column boundaries.
 * The heading is a neutral name, not an inferred merchant or transaction ID.
 * Cancellation amounts retain their visible order; their accounting meaning is
 * not inferred from a strikethrough, sign, CSS class or displayed position.
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
  const readDetails = (
    row: Element
  ): Pick<FinanceListRow, 'details' | 'detailsVisible' | 'sourceRowId'> => {
    const incomplete = { details: [], detailsVisible: false }
    const containers = visibleMatches(row, ':scope > .useList')
    if (containers.length !== 1) return incomplete
    const lists = visibleMatches(containers[0], ':scope > ul')
    if (lists.length !== 1) return incomplete
    const pairs = visibleMatches(lists[0], ':scope > li')
    if (pairs.length !== DETAIL_LABELS.length) return incomplete
    const details: FinanceListRow['details'] = []
    for (const [index, pair] of pairs.entries()) {
      const values = visibleMatches(pair, ':scope > span')
      if (values.length !== 1) return incomplete
      // The verified label is direct text outside the value span. Copy only
      // those text nodes, never inputs, attributes, nested elements or values.
      const labelNode = doc.createElement('span')
      for (const node of Array.from(pair.childNodes)) {
        if (node.nodeType === 3) labelNode.appendChild(doc.createTextNode(node.textContent ?? ''))
      }
      const label = readers.readCell(labelNode)
      if (label !== DETAIL_LABELS[index]) return incomplete
      details.push({ label, value: readers.readCell(values[0]) })
    }
    const approval = details.find(({ label }) => label === '승인번호')!.value
    const sourceRowId =
      /^[A-Za-z0-9-]{1,80}$/.test(approval) && !/^-+$/.test(approval) ? approval : undefined
    return {
      details,
      detailsVisible: true,
      ...(sourceRowId ? { sourceRowId } : {})
    }
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
    if (amounts.some((element) => element.matches('.cancel'))) {
      recordUnrecognized({ ...counts, reason: 'unsupported_variant' })
      continue
    }
    if (name.length !== 1 || amounts.length !== 1) {
      recordUnrecognized({ ...counts, reason: 'field_count' })
      continue
    }
    const isCancelled = row.matches('.cancel')
    const isPartial = amounts[0].matches('.parttot')
    const variant = isCancelled || isPartial
    let cancellationStatus: string | undefined
    if (variant) {
      const verifiedCancellation =
        isCancelled && !isPartial && amounts[0].classList.length === 0 && amount.length === 1
      const verifiedPartial =
        !isCancelled && isPartial && amounts[0].classList.length === 1 && amount.length === 2
      if (metadata.length !== 4 || (!verifiedCancellation && !verifiedPartial)) {
        recordUnrecognized({ ...counts, reason: 'unsupported_variant' })
        continue
      }
      cancellationStatus = readers.readCell(metadata[3])
      if (cancellationStatus !== (isCancelled ? '취소' : '부분취소')) {
        recordUnrecognized({ ...counts, reason: 'unsupported_variant' })
        continue
      }
    } else if (metadata.length !== 3 || amount.length !== 1) {
      recordUnrecognized({ ...counts, reason: 'field_count' })
      continue
    }
    const fields: FinanceListRow['head'][number]['field'][] = [
      'name',
      'date',
      'card',
      'payment_type'
    ]
    if (variant) fields.push('cancellation_status')
    fields.push('amount')
    if (isPartial) fields.push('secondary_amount')
    const details = readDetails(row)
    readers.countRow(fields.length + details.details.length * 2)
    const head = [name[0], ...metadata, ...amount].map((element, index) => ({
      field: fields[index],
      text:
        fields[index] === 'cancellation_status' ? cancellationStatus! : readers.readCell(element)
    }))
    const emptyFields = head.filter(({ text }) => !text).map(({ field }) => field)
    if (emptyFields.length) {
      recordUnrecognized({ ...counts, reason: 'empty_fields', emptyFields })
      continue
    }
    result.rows.push({ head, ...details })
  }
  return [result]
}
