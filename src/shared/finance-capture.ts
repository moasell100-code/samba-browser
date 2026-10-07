// Types only: page preload must not share runtime chunks with the renderer.
export type FinanceCardIssuer = 'hyundai_card' | 'samsung_card' | 'lotte_card'

export interface FinanceTableCell {
  text: string
  header: boolean
  rowSpan: number
  colSpan: number
}

export interface FinanceTableCapture {
  index: number
  rows: FinanceTableCell[][]
  hiddenRows: number
  hasNestedTable: boolean
}

export interface FinanceListRow {
  // Selector-defined column names; each text value is retained exactly as displayed.
  head: Array<{
    field:
      | 'name'
      | 'date'
      | 'sales_date'
      | 'time'
      | 'card'
      | 'payment_type'
      | 'cancellation_status'
      | 'amount'
      // A second displayed amount, in DOM order; never interpreted as refund or balance.
      | 'secondary_amount'
    text: string
  }>
  details: Array<{ label: string; value: string }>
  detailsVisible: boolean
  sourceRowId?: string
  /** Explicit displayed 업종/분야 detail only; never part of transaction identity. */
  merchantIndustry?: string
}

export interface FinanceListCapture {
  adapter:
    | 'samsung_history_list_v1'
    | 'samsung_cancellation_list_v1'
    | 'samsung_refund_list_v1'
    | 'hyundai_history_list_v1'
    | 'lotte_history_list_v1'
  rows: FinanceListRow[]
  hiddenRows: number
  unrecognizedRows: number
  hasMore: boolean
  displayedTotal?: number
  unrecognizedDiagnostics?: Array<{
    // Zero-based DOM row index. Only the first five failed rows are reported.
    rowIndex: number
    reason: 'link_count' | 'field_count' | 'empty_fields' | 'unsupported_variant'
    linkCount: number
    nameCount?: number
    metadataCount?: number
    amountCount?: number
    emptyFields?: FinanceListRow['head'][number]['field'][]
  }>
}

// Structure only. No text, IDs, form values, URL queries, or arbitrary attributes.
export interface FinanceLayoutDiagnostic {
  nodes: Array<{ depth: number; tag: string; classes: string[] }>
  truncated: boolean
}

export interface FinanceFrameCapture {
  origin: string
  pathname: string
  tables: FinanceTableCapture[]
  lists?: FinanceListCapture[]
  layoutDiagnostic?: FinanceLayoutDiagnostic
}

export interface FinancePageCapture {
  frames: FinanceFrameCapture[]
  failedFrames: number
  skippedFrames: number
}

export type FinanceCaptureIssue =
  | 'site_adapter_unverified'
  | 'query_range_unverified'
  | 'pagination_unverified'
  | 'no_tables'
  | 'frame_incomplete'
  | 'hidden_rows'
  | 'complex_table'
  | 'details_incomplete'
  | 'more_rows_available'
  | 'unrecognized_rows'
  | 'total_count_mismatch'
  | 'duplicate_rows_review'
  | 'cancellation_amount_review'

// Safe to return to a model. No financial cells, page title, account names or URL queries.
export interface FinanceCaptureReceipt {
  captureId: string
  issuer: FinanceCardIssuer
  capturedAt: string
  expiresAt: string
  tableCount: number
  rowCount: number
  listCount?: number
  listRowCount?: number
  listSummaries?: Array<{
    adapter: FinanceListCapture['adapter']
    rowCount: number
    detailsVisibleCount: number
    sourceRowIdCount: number
    // Additional rows repeating an exact displayed head tuple; never auto-deduplicated.
    duplicateVisibleRowCount: number
    displayedTotal?: number
    unrecognizedDiagnostics?: FinanceListCapture['unrecognizedDiagnostics']
    nonemptyFields: Array<{ field: FinanceListRow['head'][number]['field']; count: number }>
  }>
  frameCount: number
  previewOnly: true
  issues: FinanceCaptureIssue[]
  layoutDiagnostic?: FinanceLayoutDiagnostic
}
