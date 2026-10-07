import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import type { Tab } from '../browser/tab-manager'
import type { CardApiCollector } from './card-api-types'
import { dailyCardRanges, isCardDate, recentCardDateRange } from './card-date-range'
import { issuerForCardUrl } from './card-page-diagnostics'
import { saveCardCollectionOverSsh } from './card-save-ssh'
import { collectRecentCard, saveCardCollection, type CardSaveOptions } from './card-sync'

const rangeSchema = z.object({
  from: z.string().refine(isCardDate),
  to: z.string().refine(isCardDate)
})
const windowSchema = z.object({
  issuer: z.enum(['hyundai_card', 'samsung_card', 'lotte_card']),
  range: rangeSchema,
  approvalRange: rangeSchema,
  cancellationRange: rangeSchema,
  gapDays: z.number().int().min(0).max(36500),
  timeZone: z.literal('Asia/Seoul'),
  inclusiveDays: z.number().int().min(1).max(4)
})

/** Current four days are always collected first; recovery must never starve new approvals. */
export async function recoverCardCoverage(
  tab: Tab,
  collect: CardApiCollector,
  options: CardSaveOptions
): Promise<boolean> {
  const wc = tab.view.webContents
  const url = wc.getURL()
  const profile = tab.profile
  const unchanged = (): boolean =>
    tab.view.webContents === wc &&
    tab.profile === profile &&
    !wc.isDestroyed() &&
    wc.getURL() === url &&
    !options.signal?.aborted
  const issuer = issuerForCardUrl(url)
  if (!issuer || options.signal?.aborted) return false
  try {
    let raw: unknown
    if (options.transport === 'server-ssh') {
      raw = await saveCardCollectionOverSsh(JSON.stringify({ issuer }), options.signal, 'window')
    } else {
      if (options.transport !== 'local' || !options.tokenFile) return false
      const info = await stat(options.tokenFile)
      if (!info.isFile() || info.size > 1024) return false
      const token = (await readFile(options.tokenFile, 'utf8')).trim()
      if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) return false
      const response = await fetch(
        `http://127.0.0.1:8000/api/imports/browser-card/window?source=${issuer}`,
        {
          headers: { 'X-Finance-Collector-Token': token },
          redirect: 'error',
          signal: options.signal
            ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)])
            : AbortSignal.timeout(30000)
        }
      )
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        return false
      }
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.byteLength
          if (size > 16000) throw new Error()
          chunks.push(part.value)
        }
        raw = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } finally {
        await reader.cancel().catch(() => undefined)
      }
    }
    const window = windowSchema.parse(raw)
    if (window.issuer !== issuer || !unchanged()) return false
    const recent = recentCardDateRange()
    const ranges = [window.approvalRange, window.cancellationRange]
    for (const range of ranges) {
      dailyCardRanges(range)
      if (range.from < '2026-07-01' || range.to > recent.to) return false
    }
    // A cancellation feed without proven date semantics can keep its cursor pending
    // indefinitely. Recover approval gaps independently before revisiting that cursor.
    const recovery =
      window.approvalRange.from < recent.from
        ? window.approvalRange
        : window.cancellationRange.from < recent.from
          ? window.cancellationRange
          : undefined
    if (!recovery) return true
    const result = await collectRecentCard({
      tab,
      collect,
      range: recovery,
      signal: options.signal
    })
    if (
      !unchanged() ||
      result.receipt.issuer !== issuer ||
      result.receipt.range.from !== recovery.from ||
      result.receipt.range.to !== recovery.to
    )
      return false
    if (
      !result.rows.length &&
      !result.receipt.approvalComplete &&
      !result.receipt.cancellationComplete
    )
      return false
    await saveCardCollection(result, options)
    return result.receipt.approvalComplete === true && result.receipt.cancellationComplete === true
  } catch {
    return false
  }
}
