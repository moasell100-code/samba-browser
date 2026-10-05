import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import { CARD_DAILY_REASONS } from '../../shared/card-daily'
import type { CardSaveOptions } from './card-sync'
import { saveCardCollectionOverSsh } from './card-save-ssh'

const resultSchema = z
  .object({
    issuer: z.enum(['hyundai_card', 'samsung_card', 'lotte_card']),
    state: z.enum(['saved', 'needs_login', 'failed', 'pending']),
    reason: z
      .enum([
        ...CARD_DAILY_REASONS,
        'login_required',
        'vault_locked',
        'credentials_missing',
        'additional_auth_required',
        'login_failed',
        'retry_blocked',
        'interrupted',
        'sync_unavailable',
        'collection_incomplete',
        'history_page_required',
        'collector_unavailable',
        'already_running',
        'busy',
        'disabled',
        'unknown'
      ])
      .optional(),
    approvalComplete: z.boolean().optional(),
    complete: z.boolean().optional(),
    insertedRows: z.number().int().min(0).max(10_000).optional(),
    updatedRows: z.number().int().min(0).max(10_000).optional()
  })
  .strict()
const reportSchema = z
  .object({
    enabled: z.boolean(),
    hourKst: z.number().int().min(0).max(23),
    phase: z.enum(['idle', 'running', 'completed', 'needs_attention', 'paused']),
    runDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    startedAt: z.string().datetime({ offset: true }).optional(),
    finishedAt: z.string().datetime({ offset: true }).optional(),
    gapDays: z.number().int().min(0).max(36500),
    results: z.array(resultSchema).max(3)
  })
  .strict()

export type CardScheduleReport = z.infer<typeof reportSchema>
export type CardScheduleReportResult = z.infer<typeof resultSchema>

/** Publish only bounded execution metadata. Never transport credentials or transaction rows. */
export async function reportCardSchedule(
  report: CardScheduleReport,
  options: CardSaveOptions
): Promise<boolean> {
  try {
    const body = JSON.stringify(reportSchema.parse(report))
    if (Buffer.byteLength(body) > 8192 || options.signal?.aborted) return false
    if (options.transport === 'server-ssh') {
      const reply = await saveCardCollectionOverSsh(body, options.signal, 'schedule-report')
      return z
        .object({ ok: z.literal(true) })
        .strict()
        .safeParse(reply).success
    }
    if (options.transport !== 'local' || !options.tokenFile) return false
    const info = await stat(options.tokenFile)
    if (!info.isFile() || info.size > 1024) return false
    const token = (await readFile(options.tokenFile, 'utf8')).trim()
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) return false
    const response = await fetch('http://127.0.0.1:8000/api/imports/browser-card/schedule-report', {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Finance-Collector-Token': token },
      body,
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000)
    })
    const ok = response.ok
    await response.body?.cancel()
    return ok
  } catch {
    return false
  }
}
