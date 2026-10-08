import type { Tab } from '../browser/tab-manager'
import type { FinanceCardIssuer } from '../../shared/finance-capture'

export interface CardDateRange {
  from: string
  to: string
}

/** Private main-process data. Never return rows to an agent/MCP response or log them. */
export interface CardApiRow {
  issuer: FinanceCardIssuer
  sourceId: string
  kind: 'approval' | 'cancellation' | 'status'
  approvedAt: string
  eventDate?: string
  /** Issuer's displayed date used to validate the query; not independent refund-date proof. */
  queryDate?: string
  approvalNumber?: string
  /** Private stable issuer card reference digest; never a reconstructed card number. */
  cardKey?: string
  /** Actual last four positions, preserving issuer-provided '*' masking. */
  cardLast4?: string
  cardLabel?: string
  merchant: string
  /** Explicit issuer-provided industry text only, at most 200 characters. */
  merchantIndustry?: string
  /** Original approval amount; a cancellation screen may repeat this rather than its refund. */
  amount: number
  /** false only for a refund event whose original gross must be resolved in the ledger. */
  originalAmountKnown?: boolean
  currency: 'KRW'
  status: 'approved' | 'cancelled' | 'partially_cancelled' | 'unknown'
  cancellationAmount: number | null
  /** Verified issuer refund semantics, independent of whole-query coverage. */
  cancellationEvidence?: boolean
  cancellationAmountType?: 'cumulative' | 'event'
  /** Digest of an official unique refund identifier, never raw account data. */
  cancellationEventId?: string
  netAmount: number | null
  needsReview: string[]
}

export interface CardApiReceipt {
  issuer: FinanceCardIssuer
  range: CardDateRange
  pages: number
  rowCount: number
  complete: boolean
  /** Verified approval coverage only; cancellation reconciliation may still be incomplete. */
  approvalComplete?: boolean
  cancellationComplete?: boolean
  /** Verified cancellation-query coverage, distinct from a global cancellation-event feed. */
  cancellationQueryComplete?: boolean
  cancellationQueryBasis?: 'original_approval_date' | 'issuer_display_date'
  /** All original approvals in this date range have verified current status. */
  statusComplete?: boolean
  issues: string[]
  elapsedMs: number
}

export interface CardApiResult {
  rows: CardApiRow[]
  receipt: CardApiReceipt
  /** Private official S32 export evidence, delivered only to the finance backend. */
  cancellationWorkbooks?: {
    range: CardDateRange
    expectedRows: number
    contentBase64: string
  }[]
}

export interface CardApiOptions {
  signal?: AbortSignal
  maxPages?: number
}

export type CardApiCollector = (
  tab: Tab,
  range: CardDateRange,
  options?: CardApiOptions
) => Promise<CardApiResult>
