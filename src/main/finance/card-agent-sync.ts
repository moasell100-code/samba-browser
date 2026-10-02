import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { Tab } from '../browser/tab-manager'
import { pageBridge } from '../browser/page-bridge'
import type { FinanceCardIssuer } from '../../shared/finance-capture'
import type { CardApiCollector, CardDateRange } from './card-api-types'
import { CARD_HISTORY_URLS, issuerForCardUrl } from './card-page-diagnostics'
import { recentCardDateRange } from './card-date-range'
import { collectRecentCard, saveCardCollection } from './card-sync'
import { collectSamsungApi } from './samsung-api-collector'
import { collectLotteApi } from './lotte-api-collector'
import { collectHyundaiApi } from './hyundai-api-collector'

// The internal abort precedes the agent tool deadline so a timed-out call cannot save later.
export const CARD_AGENT_SYNC_TIMEOUT_MS = 450_000
export const CARD_AGENT_TOOL_TIMEOUT_MS = 480_000

const collectors: Partial<Record<FinanceCardIssuer, CardApiCollector>> = {
  samsung_card: collectSamsungApi,
  lotte_card: collectLotteApi,
  hyundai_card: collectHyundaiApi
}
const busy = new WeakSet<object>()

export type CardAgentSyncResult =
  | {
      ok: true
      issuer: FinanceCardIssuer
      range: CardDateRange
      pages: number
      totalRows: number
      insertedRows: number
      updatedRows: number
      skippedRows: number
      reviewRows: number
      duplicateBatch: boolean
      complete: boolean
    }
  | {
      ok: false
      reason:
        | 'history_page_required'
        | 'collector_unavailable'
        | 'login_required'
        | 'already_running'
        | 'interrupted'
        | 'sync_unavailable'
    }

export type CardAgentSync = (tab: Tab) => Promise<CardAgentSyncResult>

function historyIssuer(url: string): FinanceCardIssuer | null {
  const issuer = issuerForCardUrl(url)
  if (!issuer) return null
  try {
    return new URL(url).pathname === new URL(CARD_HISTORY_URLS[issuer]).pathname ? issuer : null
  } catch {
    return null
  }
}

/** Configure only the local agent. No credentials, token paths, or private rows enter its output. */
export async function createCardAgentSync(options: {
  tokenFile?: string
  signal?: AbortSignal
}): Promise<CardAgentSync | undefined> {
  const tokenFile = options.tokenFile?.trim()
  if (!tokenFile || !isAbsolute(tokenFile)) return undefined
  try {
    const info = await stat(tokenFile)
    if (!info.isFile() || info.size < 43 || info.size > 1024) return undefined
    if (!/^[A-Za-z0-9_-]{43,128}$/.test((await readFile(tokenFile, 'utf8')).trim()))
      return undefined
  } catch {
    return undefined
  }
  return async (tab) => {
    const wc = tab.view.webContents
    let initialUrl: string
    try {
      if (wc.isDestroyed()) return { ok: false, reason: 'interrupted' }
      initialUrl = wc.getURL()
    } catch {
      return { ok: false, reason: 'interrupted' }
    }
    const issuer = historyIssuer(initialUrl)
    if (!issuer) return { ok: false, reason: 'history_page_required' }
    const collect = collectors[issuer]
    if (!collect) return { ok: false, reason: 'collector_unavailable' }
    if (busy.has(wc)) return { ok: false, reason: 'already_running' }
    busy.add(wc)
    const controller = new AbortController()
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal
    const interrupt = (): void => controller.abort()
    const navigate = (
      _event: unknown,
      _url: string,
      _inPlace: boolean,
      mainFrame: boolean
    ): void => {
      if (mainFrame) interrupt()
    }
    wc.on('did-start-navigation', navigate)
    wc.on('destroyed', interrupt)
    const timer = setTimeout(interrupt, CARD_AGENT_SYNC_TIMEOUT_MS)
    let onAbort: () => void = () => {}
    const aborted = new Promise<CardAgentSyncResult>((resolve) => {
      onAbort = () => resolve({ ok: false, reason: 'interrupted' })
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    const unchanged = (): boolean =>
      !signal.aborted && !wc.isDestroyed() && wc.getURL() === initialUrl
    const work = async (): Promise<CardAgentSyncResult> => {
      try {
        if (!unchanged()) return { ok: false, reason: 'interrupted' }
        const verified =
          issuer === 'hyundai_card'
            ? (await pageBridge.hyundaiAuth(tab)).state === 'signed_in'
            : await pageBridge
                .cardSession(tab)
                .then((session) => session.issuer === issuer && session.state === 'signed_in')
        if (!unchanged()) return { ok: false, reason: 'interrupted' }
        if (!verified) return { ok: false, reason: 'login_required' }
        const range = recentCardDateRange()
        const result = await collectRecentCard({ tab, collect, range, signal })
        if (!unchanged()) return { ok: false, reason: 'interrupted' }
        if (
          result.receipt.issuer !== issuer ||
          result.receipt.range.from !== range.from ||
          result.receipt.range.to !== range.to
        )
          return { ok: false, reason: 'sync_unavailable' }
        const saved = await saveCardCollection(result, { tokenFile, signal })
        // Explicit projection: no row data, arbitrary issue text, or server identifiers.
        return {
          ok: true,
          issuer: saved.source,
          range,
          pages: saved.pages,
          totalRows: saved.total_rows,
          insertedRows: saved.inserted_rows,
          updatedRows: saved.updated_rows,
          skippedRows: saved.skipped_rows,
          reviewRows: saved.review_rows,
          duplicateBatch: saved.duplicate_batch,
          complete: saved.complete
        }
      } catch {
        return { ok: false, reason: signal.aborted ? 'interrupted' : 'sync_unavailable' }
      }
    }
    try {
      return await Promise.race([work(), aborted])
    } finally {
      controller.abort()
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      wc.removeListener('did-start-navigation', navigate)
      wc.removeListener('destroyed', interrupt)
      busy.delete(wc)
    }
  }
}
