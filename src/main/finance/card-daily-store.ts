import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { CARD_DAILY_ISSUERS, CARD_DAILY_REASONS, CARD_DAILY_STAGES } from '../../shared/card-daily'
import { isCardDate } from './card-date-range'
import { CARD_NAVIGATION_CODES, CARD_NAVIGATION_CATEGORIES } from '../../shared/card-navigation'

const date = z.string().refine(isCardDate)
const count = z.number().int().nonnegative().max(10_000_000)
const result = z
  .object({
    issuer: z.enum(CARD_DAILY_ISSUERS),
    state: z.enum(['saved', 'needs_login', 'failed', 'pending', 'running']),
    reason: z.enum(CARD_DAILY_REASONS).optional(),
    stage: z.enum(CARD_DAILY_STAGES).optional(),
    loginAttempted: z.boolean().optional(),
    failureKind: z.enum(['navigation_aborted', 'navigation_failed', 'operation_failed']).optional(),
    navigationFailure: z
      .object({ code: z.enum(CARD_NAVIGATION_CODES), category: z.enum(CARD_NAVIGATION_CATEGORIES) })
      .strict()
      .optional(),
    navigationTrace: z
      .object({
        loadResult: z.enum(['not_started', 'promise', 'resolved', 'non_thenable']),
        observedOrigin: z.enum(['about_blank', 'expected_issuer', 'other', 'unavailable']),
        errorName: z.enum(['TypeError', 'ReferenceError', 'Error', 'unknown']),
        errorHint: z.enum([
          'then_not_callable',
          'undefined_property',
          'destroyed_object',
          'unknown'
        ])
      })
      .strict()
      .optional(),
    approvalComplete: z.boolean().optional(),
    cancellationComplete: z.boolean().optional(),
    complete: z.boolean().optional(),
    totalRows: count.optional(),
    insertedRows: count.optional(),
    updatedRows: count.optional(),
    reviewRows: count.optional(),
    reconciliation: z
      .object({
        state: z.enum(['no_work', 'checked', 'needs_review', 'failed']),
        checkedDays: z.number().int().min(0).max(31),
        reviewRows: count,
        updatedRows: count
      })
      .strict()
      .optional()
  })
  .strict()
const run = z
  .object({
    runDate: date,
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().optional(),
    results: z
      .array(result)
      .length(3)
      .refine((rows) => new Set(rows.map((row) => row.issuer)).size === 3)
  })
  .strict()
export const cardDailyFileSchema = z
  .object({
    version: z.literal(1),
    gapDays: count,
    lastCovered: z
      .object({
        hyundai_card: date.optional(),
        samsung_card: date.optional(),
        lotte_card: date.optional()
      })
      .strict(),
    loginBlocked: z
      .object({
        hyundai_card: z.boolean().optional(),
        samsung_card: z.boolean().optional(),
        lotte_card: z.boolean().optional()
      })
      .strict()
      .optional(),
    run: run.optional()
  })
  .strict()
export type CardDailyFile = z.infer<typeof cardDailyFileSchema>
export interface CardDailyStore {
  read(): CardDailyFile
  write(value: CardDailyFile): void
}

/** Device-local counts/enums only. A damaged or unwritable record must never re-arm logins. */
export class FileCardDailyStore implements CardDailyStore {
  constructor(private readonly file: string) {}
  read(): CardDailyFile {
    if (!existsSync(this.file)) return { version: 1, gapDays: 0, lastCovered: {} }
    try {
      const raw = readFileSync(this.file, 'utf8')
      if (raw.length > 32_768) throw new Error()
      return cardDailyFileSchema.parse(JSON.parse(raw))
    } catch {
      throw new Error('Card schedule storage unavailable')
    }
  }
  write(value: CardDailyFile): void {
    const safe = cardDailyFileSchema.parse(value)
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(temporary, JSON.stringify(safe), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.file)
    } catch {
      try {
        unlinkSync(temporary)
      } catch {
        /* best effort temporary cleanup */
      }
      throw new Error('Card schedule storage unavailable')
    }
  }
}
