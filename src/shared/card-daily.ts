export const CARD_DAILY_ISSUERS = ['hyundai_card', 'samsung_card', 'lotte_card'] as const
export type CardDailyIssuer = (typeof CARD_DAILY_ISSUERS)[number]
export const CARD_DAILY_REASONS = [
  'agent_busy',
  'vault_locked',
  'policy_blocked',
  'not_configured',
  'attempt_protected',
  'login_required',
  'user_verification_required',
  'login_unconfirmed',
  'collection_incomplete',
  'sync_unavailable',
  'interrupted',
  'navigation_changed',
  'timeout',
  'storage_unavailable',
  'coverage_gap',
  'review_required'
] as const
export type CardDailyReason = (typeof CARD_DAILY_REASONS)[number]
export const CARD_DAILY_STAGES = [
  'prepare_tab',
  'open_history',
  'inspect_session',
  'restore_session',
  'reopen_history',
  'verify_restored_session',
  'prepare_sync',
  'collect_save',
  'reconcile'
] as const
export type CardDailyStage = (typeof CARD_DAILY_STAGES)[number]
export interface CardDailyResult {
  issuer: CardDailyIssuer
  state: 'saved' | 'needs_login' | 'failed' | 'pending' | 'running'
  reason?: CardDailyReason
  stage?: CardDailyStage
  loginAttempted?: boolean
  failureKind?: 'navigation_aborted' | 'navigation_failed' | 'operation_failed'
  navigationFailure?: CardNavigationFailure
  approvalComplete?: boolean
  complete?: boolean
  totalRows?: number
  insertedRows?: number
  updatedRows?: number
  reviewRows?: number
  reconciliation?: {
    state: 'no_work' | 'checked' | 'needs_review' | 'failed'
    checkedDays: number
    reviewRows: number
    updatedRows: number
  }
}
export interface CardDailyStatus {
  enabled: boolean
  hourKst: number
  phase: 'idle' | 'running' | 'completed' | 'needs_attention' | 'paused'
  runDate?: string
  startedAt?: string
  finishedAt?: string
  gapDays: number
  results: CardDailyResult[]
  nextRunAt: string | null
  reason?: CardDailyReason
}
import type { CardNavigationFailure } from './card-navigation'
