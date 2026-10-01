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

// Structure only. No text, IDs, form values, URL queries, or arbitrary attributes.
export interface FinanceLayoutDiagnostic {
  nodes: Array<{ depth: number; tag: string; classes: string[] }>
  truncated: boolean
}

export interface FinanceFrameCapture {
  origin: string
  pathname: string
  tables: FinanceTableCapture[]
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

// Safe to return to a model. No financial cells, page title, account names or URL queries.
export interface FinanceCaptureReceipt {
  captureId: string
  issuer: FinanceCardIssuer
  capturedAt: string
  expiresAt: string
  tableCount: number
  rowCount: number
  frameCount: number
  previewOnly: true
  issues: FinanceCaptureIssue[]
  layoutDiagnostic?: FinanceLayoutDiagnostic
}
