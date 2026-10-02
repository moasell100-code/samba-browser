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
  approvalNumber?: string
  cardLast4?: string
  cardLabel?: string
  merchant: string
  /** Original approval amount; a cancellation screen may repeat this rather than its refund. */
  amount: number
  currency: 'KRW'
  status: 'approved' | 'cancelled' | 'partially_cancelled' | 'unknown'
  cancellationAmount: number | null
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
  issues: string[]
  elapsedMs: number
}

export interface CardApiResult {
  rows: CardApiRow[]
  receipt: CardApiReceipt
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
