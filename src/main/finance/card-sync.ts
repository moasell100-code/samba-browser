import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import type { Tab } from '../browser/tab-manager'
import type { CardApiCollector, CardApiResult, CardDateRange } from './card-api-types'
import { dailyCardRanges, recentCardDateRange } from './card-date-range'
import { issuerForCardUrl } from './card-page-diagnostics'
import { saveCardCollectionOverSsh } from './card-save-ssh'

export type CardSaveOptions = { tokenFile?: string; transport?: string; signal?: AbortSignal }

const saveReceipt = z.object({
  batch_id: z.union([z.number().int(), z.string().max(100)]),
  source: z.enum(['hyundai_card', 'samsung_card', 'lotte_card']),
  duplicate_batch: z.boolean(),
  total_rows: z.number().int().nonnegative(),
  inserted_rows: z.number().int().nonnegative(),
  updated_rows: z.number().int().nonnegative(),
  skipped_rows: z.number().int().nonnegative(),
  review_rows: z.number().int().nonnegative(),
  status: z.enum([
    'completed',
    'needs_review',
    'partial',
    'complete',
    'imported',
    'review_required'
  ]),
  complete: z.boolean(),
  approval_complete: z.boolean().optional(),
  range: z.object({ from: z.string(), to: z.string() }),
  pages: z.number().int()
})

export async function collectRecentCard(options: {
  tab: Tab
  collect: CardApiCollector
  range?: CardDateRange
  signal?: AbortSignal
}): Promise<CardApiResult> {
  const range = options.range ?? recentCardDateRange()
  const started = Date.now()
  const parts: CardApiResult[] = []
  for (const day of dailyCardRanges(range)) {
    if (options.signal?.aborted) break
    let part: CardApiResult
    try {
      part = await options.collect(options.tab, day, { signal: options.signal, maxPages: 100 })
    } catch {
      const issuer =
        parts[0]?.receipt.issuer ?? issuerForCardUrl(options.tab.view.webContents.getURL())
      if (!issuer) throw new Error('Card collection unavailable')
      parts.push({
        rows: [],
        receipt: {
          issuer,
          range: day,
          pages: 0,
          rowCount: 0,
          complete: false,
          issues: ['collector_error'],
          elapsedMs: Date.now() - started
        }
      })
      break
    }
    parts.push(part)
    if (part.receipt.issues.some((issue) => /signed_out|auth|session|navigation|abort/.test(issue)))
      break
    if (!part.receipt.approvalComplete && part.receipt.issues.includes('service_error')) break
  }
  if (!parts.length) throw new Error('Card collection unavailable')
  const rows: CardApiResult['rows'] = []
  const identities = new Map<string, Map<string, CardApiResult['rows'][number]>>()
  const industriesByRow = new Map<CardApiResult['rows'][number], Set<string>>()
  let identityConflict = false
  for (const row of parts.flatMap((part) => part.rows)) {
    const industryText = row.merchantIndustry?.trim()
    const industry = industryText && industryText.length <= 200 ? industryText : undefined
    const identity = JSON.stringify([row.issuer, row.sourceId])
    const payload = JSON.stringify(
      Object.fromEntries(
        Object.entries(row)
          .filter(([key]) => key !== 'needsReview' && key !== 'merchantIndustry')
          .sort(([a], [b]) => a.localeCompare(b))
      )
    )
    let versions = identities.get(identity)
    if (!versions) identities.set(identity, (versions = new Map()))
    const same = versions.get(payload)
    if (same) {
      same.needsReview = [...new Set([...same.needsReview, ...row.needsReview])]
      const industries = industriesByRow.get(same)!
      if (industry) industries.add(industry)
      // Conflicting descriptions remain absent; neither label establishes a new
      // financial identity, and a later missing value must not erase known text.
      if (industries.size === 1) same.merchantIndustry = industries.values().next().value
      else delete same.merchantIndustry
      continue
    }
    const copy = { ...row, needsReview: [...row.needsReview] }
    delete copy.merchantIndustry
    if (industry) copy.merchantIndustry = industry
    industriesByRow.set(copy, new Set(industry ? [industry] : []))
    if (versions.size) {
      identityConflict = true
      for (const version of [...versions.values(), copy])
        version.needsReview = [...new Set([...version.needsReview, 'source_identity_conflict'])]
    }
    versions.set(payload, copy)
    rows.push(copy)
  }
  const issues = [...new Set(parts.flatMap((part) => part.receipt.issues))]
  if (identityConflict) issues.push('source_identity_conflict')
  const complete =
    !identityConflict &&
    parts.length === dailyCardRanges(range).length &&
    parts.every((part) => part.receipt.complete)
  if (parts.length !== dailyCardRanges(range).length) issues.push('date_range_incomplete')
  return {
    rows,
    receipt: {
      issuer: parts[0].receipt.issuer,
      range,
      rowCount: rows.length,
      pages: parts.reduce((total, part) => total + part.receipt.pages, 0),
      complete,
      approvalComplete:
        !identityConflict &&
        parts.length === dailyCardRanges(range).length &&
        parts.every((part) => part.receipt.approvalComplete === true),
      issues,
      elapsedMs: Date.now() - started
    }
  }
}

/** Only the configured finance backend receives private rows. MCP receives this safe receipt. */
async function saveCardCollectionInternal(
  result: CardApiResult,
  options: CardSaveOptions
): Promise<z.infer<typeof saveReceipt>> {
  const body = JSON.stringify({ ...result, collectedAt: new Date().toISOString() })
  if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error('Finance collection too large')
  if (options.transport === 'server-ssh') {
    const raw = await saveCardCollectionOverSsh(body, options.signal)
    const parsed = saveReceipt.safeParse(raw)
    if (
      !parsed.success ||
      parsed.data.source !== result.receipt.issuer ||
      parsed.data.range.from !== result.receipt.range.from ||
      parsed.data.range.to !== result.receipt.range.to
    )
      throw new Error('Finance collector receipt invalid')
    return parsed.data
  }
  if ((options.transport !== undefined && options.transport !== 'local') || !options.tokenFile)
    throw new Error('Finance collector not configured')
  const info = await stat(options.tokenFile)
  if (!info.isFile() || info.size > 1024) throw new Error('Finance collector not configured')
  const token = (await readFile(options.tokenFile, 'utf8')).trim()
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error('Finance collector not configured')
  const response = await fetch('http://127.0.0.1:8000/api/imports/browser-card', {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json', 'X-Finance-Collector-Token': token },
    body,
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000)
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error('Finance collector save rejected')
  }
  if (!response.body) throw new Error('Finance collector receipt invalid')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 16000) throw new Error('Finance collector receipt invalid')
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('Finance collector receipt invalid')
  }
  const parsed = saveReceipt.safeParse(raw)
  if (!parsed.success || parsed.data.source !== result.receipt.issuer)
    throw new Error('Finance collector receipt invalid')
  return parsed.data
}

export async function saveCardCollection(
  result: CardApiResult,
  options: CardSaveOptions
): Promise<z.infer<typeof saveReceipt>> {
  try {
    return await saveCardCollectionInternal(result, options)
  } catch (error) {
    const safe = new Set([
      'Finance collector not configured',
      'Finance collection too large',
      'Finance collector save rejected',
      'Finance collector receipt invalid'
    ])
    throw new Error(
      error instanceof Error && safe.has(error.message)
        ? error.message
        : 'Finance collector save unavailable'
    )
  }
}
