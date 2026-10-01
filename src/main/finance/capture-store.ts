import { createHash, randomUUID } from 'node:crypto'
import type {
  FinanceCaptureIssue,
  FinanceCaptureReceipt,
  FinanceListRow,
  FinancePageCapture
} from '../../shared/finance-capture'
import { financeCardIssuer, financePageCaptureSchema } from './capture-schema'

export const FINANCE_CAPTURE_TTL_MS = 10 * 60 * 1000
export const FINANCE_CAPTURE_MAX_ITEMS = 10
export const FINANCE_CAPTURE_MAX_BYTES = 4 * 1024 * 1024
export const FINANCE_CAPTURE_MAX_ITEM_BYTES = 1024 * 1024

interface StoredCapture {
  receipt: FinanceCaptureReceipt
  page: FinancePageCapture
  digest: string
  expires: number
  bytes: number
}

function duplicateVisibleRows(rows: FinanceListRow[]): number {
  const seen = new Set<string>()
  let duplicates = 0
  for (const row of rows) {
    const identity = JSON.stringify(row.head.map(({ field, text }) => [field, text]))
    if (seen.has(identity)) duplicates += 1
    else seen.add(identity)
  }
  return duplicates
}

/** Create one store per agent run. Never expose readForReview as an agent tool. */
export class FinanceCaptureStore {
  private captures = new Map<string, StoredCapture>()
  private bytes = 0
  private expiryTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly now: () => number = Date.now) {}

  private prune(): void {
    const now = this.now()
    for (const [id, capture] of this.captures) {
      if (capture.expires <= now) this.remove(id)
    }
  }

  private remove(id: string): void {
    const stored = this.captures.get(id)
    if (stored) this.bytes -= stored.bytes
    this.captures.delete(id)
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
    const first = this.captures.values().next().value
    if (!first) return
    this.expiryTimer = setTimeout(
      () => {
        this.expiryTimer = undefined
        this.prune()
        this.scheduleExpiry()
      },
      Math.max(1, first.expires - this.now())
    )
    this.expiryTimer.unref()
  }

  save(page: FinancePageCapture): FinanceCaptureReceipt {
    this.prune()
    const valid = financePageCaptureSchema.safeParse(page)
    if (!valid.success) throw new Error('finance_capture_invalid')
    const issuer = financeCardIssuer(valid.data.frames[0].origin)
    if (!issuer) throw new Error('finance_capture_invalid')
    const raw = JSON.stringify(valid.data)
    const bytes = Buffer.byteLength(raw)
    if (bytes > FINANCE_CAPTURE_MAX_ITEM_BYTES) throw new Error('finance_capture_limit')
    while (
      this.captures.size >= FINANCE_CAPTURE_MAX_ITEMS ||
      this.bytes + bytes > FINANCE_CAPTURE_MAX_BYTES
    ) {
      const oldest = this.captures.keys().next().value
      if (oldest === undefined) throw new Error('finance_capture_limit')
      this.remove(oldest)
    }
    const tables = valid.data.frames.flatMap((frame) => frame.tables)
    const lists = valid.data.frames.flatMap((frame) => frame.lists ?? [])
    const duplicateCounts = lists.map((list) => duplicateVisibleRows(list.rows))
    const issues: FinanceCaptureIssue[] = ['query_range_unverified', 'pagination_unverified']
    if (!lists.length || tables.length || lists.some((list) => list.unrecognizedRows))
      issues.unshift('site_adapter_unverified')
    if (tables.length === 0 && lists.length === 0) issues.push('no_tables')
    if (valid.data.failedFrames || valid.data.skippedFrames) issues.push('frame_incomplete')
    if (tables.some((table) => table.hiddenRows > 0) || lists.some((list) => list.hiddenRows > 0))
      issues.push('hidden_rows')
    if (lists.some((list) => list.rows.some((row) => !row.detailsVisible)))
      issues.push('details_incomplete')
    if (lists.some((list) => list.hasMore)) issues.push('more_rows_available')
    if (lists.some((list) => list.unrecognizedRows)) issues.push('unrecognized_rows')
    if (
      lists.some(
        (list) => list.displayedTotal !== undefined && list.rows.length !== list.displayedTotal
      )
    )
      issues.push('total_count_mismatch')
    if (duplicateCounts.some((count) => count > 0)) issues.push('duplicate_rows_review')
    if (
      tables.some(
        (table) =>
          table.hasNestedTable ||
          table.rows.some((row) => row.some((cell) => cell.rowSpan !== 1 || cell.colSpan !== 1))
      )
    ) {
      issues.push('complex_table')
    }
    const now = this.now()
    const receipt: FinanceCaptureReceipt = {
      captureId: randomUUID(),
      issuer,
      capturedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + FINANCE_CAPTURE_TTL_MS).toISOString(),
      tableCount: tables.length,
      rowCount: tables.reduce((count, table) => count + table.rows.length, 0),
      ...(lists.length
        ? {
            listCount: lists.length,
            listRowCount: lists.reduce((count, list) => count + list.rows.length, 0),
            listSummaries: lists.map((list, index) => {
              const fields = new Map<FinanceListRow['head'][number]['field'], number>()
              for (const row of list.rows)
                for (const cell of row.head) {
                  fields.set(cell.field, (fields.get(cell.field) ?? 0) + (cell.text.trim() ? 1 : 0))
                }
              return {
                adapter: list.adapter,
                rowCount: list.rows.length,
                detailsVisibleCount: list.rows.filter((row) => row.detailsVisible).length,
                sourceRowIdCount: list.rows.filter((row) => row.sourceRowId).length,
                duplicateVisibleRowCount: duplicateCounts[index],
                ...(list.displayedTotal !== undefined
                  ? { displayedTotal: list.displayedTotal }
                  : {}),
                nonemptyFields: Array.from(fields, ([field, count]) => ({ field, count }))
              }
            })
          }
        : {}),
      frameCount: valid.data.frames.length,
      previewOnly: true,
      issues,
      // Only the main frame's tightly scoped structure may leave the capture store.
      ...(tables.length === 0 && lists.length === 0 && valid.data.frames[0].layoutDiagnostic
        ? { layoutDiagnostic: valid.data.frames[0].layoutDiagnostic }
        : {})
    }
    this.captures.set(receipt.captureId, {
      receipt,
      page: valid.data,
      digest: createHash('sha256').update(raw).digest('hex'),
      expires: now + FINANCE_CAPTURE_TTL_MS,
      bytes
    })
    this.bytes += bytes
    this.scheduleExpiry()
    return structuredClone(receipt)
  }

  // For a future local review UI/verified adapter only. No network or ledger write exists here.
  readForReview(
    captureId: string
  ): { receipt: FinanceCaptureReceipt; page: FinancePageCapture; digest: string } | null {
    this.prune()
    const stored = this.captures.get(captureId)
    return stored
      ? structuredClone({ receipt: stored.receipt, page: stored.page, digest: stored.digest })
      : null
  }

  clear(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
    this.captures.clear()
    this.bytes = 0
  }
}
