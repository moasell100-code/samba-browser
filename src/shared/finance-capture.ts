// Types only: page preload must not share runtime chunks with the renderer.
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

export interface FinanceFrameCapture {
  origin: string
  pathname: string
  tables: FinanceTableCapture[]
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

// Safe to return to a model. No financial cells, page title, account names or URL queries.
export interface FinanceCaptureReceipt {
  captureId: string
  issuer: 'hyundai_card'
  capturedAt: string
  expiresAt: string
  tableCount: number
  rowCount: number
  frameCount: number
  previewOnly: true
  issues: FinanceCaptureIssue[]
}
