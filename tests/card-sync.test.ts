import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../src/main/browser/tab-manager'
import type { CardApiResult, CardApiRow, CardDateRange } from '../src/main/finance/card-api-types'
import { collectRecentCard, saveCardCollection } from '../src/main/finance/card-sync'

const files = vi.hoisted(() => ({ stat: vi.fn(), readFile: vi.fn() }))
vi.mock('node:fs/promises', () => files)

const TOKEN = 'a'.repeat(64)
const RANGE = { from: '2026-09-29', to: '2026-10-02' }
const TAB = {} as Tab

function row(id = 'synthetic-approval'): CardApiRow {
  return {
    issuer: 'lotte_card',
    sourceId: id,
    kind: 'approval',
    approvedAt: '2026-10-02',
    approvalNumber: 'SYNTHETIC_APPROVAL',
    cardLast4: '1234',
    merchant: 'PRIVATE_MERCHANT',
    amount: 10000,
    currency: 'KRW',
    status: 'approved',
    cancellationAmount: 0,
    netAmount: 10000,
    needsReview: []
  }
}

function result(
  range: CardDateRange = RANGE,
  rows: CardApiRow[] = [row()],
  changes: Partial<CardApiResult['receipt']> = {}
): CardApiResult {
  return {
    rows,
    receipt: {
      issuer: 'lotte_card',
      range,
      rowCount: rows.length,
      pages: 1,
      complete: true,
      issues: [],
      elapsedMs: 50,
      ...changes
    }
  }
}

function saved(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    batch_id: 'synthetic-batch',
    source: 'lotte_card',
    duplicate_batch: false,
    total_rows: 1,
    inserted_rows: 1,
    updated_rows: 0,
    skipped_rows: 0,
    review_rows: 0,
    status: 'completed',
    complete: true,
    range: RANGE,
    pages: 4,
    ...changes
  }
}

beforeEach(() => {
  files.stat.mockResolvedValue({ isFile: () => true, size: TOKEN.length })
  files.readFile.mockResolvedValue(TOKEN)
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('recent private card collection', () => {
  it('queries today-inclusive four Korean dates in order across the UTC date boundary', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-30T15:01:00Z'))
    const collect = vi.fn(async (_tab: Tab, range: CardDateRange) =>
      result(range, [row(range.from)], { pages: 2 })
    )
    const output = await collectRecentCard({ tab: TAB, collect })
    expect(collect.mock.calls.map((call) => call[1])).toEqual([
      { from: '2026-09-28', to: '2026-09-28' },
      { from: '2026-09-29', to: '2026-09-29' },
      { from: '2026-09-30', to: '2026-09-30' },
      { from: '2026-10-01', to: '2026-10-01' }
    ])
    expect(output.receipt).toMatchObject({
      range: { from: '2026-09-28', to: '2026-10-01' },
      pages: 8,
      rowCount: 4,
      complete: true
    })
    expect(JSON.stringify(output.receipt)).not.toContain('PRIVATE_MERCHANT')
  })

  it('keeps collected rows and marks the combined batch incomplete after session expiry', async () => {
    const collect = vi.fn(async (_tab: Tab, range: CardDateRange) =>
      range.from === RANGE.from
        ? result(range)
        : result(range, [], { complete: false, issues: ['authentication_required'] })
    )
    const output = await collectRecentCard({ tab: TAB, collect, range: RANGE })
    expect(collect).toHaveBeenCalledTimes(2)
    expect(output.rows).toHaveLength(1)
    expect(output.receipt).toMatchObject({ complete: false, rowCount: 1 })
    expect(output.receipt.issues).toEqual(
      expect.arrayContaining(['authentication_required', 'date_range_incomplete'])
    )
  })

  it('retains verified daily rows when another daily page is incomplete', async () => {
    const collect = vi.fn(async (_tab: Tab, range: CardDateRange) =>
      result(
        range,
        [row(range.from)],
        range.from === RANGE.from ? { complete: false, issues: ['pagination_unverified'] } : {}
      )
    )
    const output = await collectRecentCard({ tab: TAB, collect, range: RANGE })
    expect(collect).toHaveBeenCalledTimes(4)
    expect(output.rows).toHaveLength(4)
    expect(output.receipt).toMatchObject({
      complete: false,
      pages: 4,
      rowCount: 4,
      issues: ['pagination_unverified']
    })
  })

  it('preserves approval and cancellation snapshots with a shared identity for backend reconciliation', async () => {
    const approved = row()
    const cancelled: CardApiRow = {
      ...approved,
      kind: 'status',
      status: 'cancelled',
      eventDate: '2026-10-02',
      cancellationAmount: 10000,
      netAmount: 0
    }
    let count = 0
    const collect = vi.fn(async (_tab: Tab, range: CardDateRange) =>
      result(range, count++ === 0 ? [approved] : count === 4 ? [cancelled] : [])
    )
    const output = await collectRecentCard({ tab: TAB, collect, range: RANGE })
    expect(output.rows).toEqual([approved, cancelled])
    expect(output.receipt).toMatchObject({ complete: true, rowCount: 2 })
  })

  it('retains earlier rows as incomplete when a later collector throws without exposing its exception', async () => {
    let count = 0
    const collect = vi.fn(async (_tab: Tab, range: CardDateRange) => {
      if (++count === 2) throw new Error('PRIVATE_COLLECTOR_RESPONSE')
      return result(range)
    })
    const output = await collectRecentCard({ tab: TAB, collect, range: RANGE })
    expect(collect).toHaveBeenCalledTimes(2)
    expect(output.rows).toHaveLength(1)
    expect(output.receipt.complete).toBe(false)
    expect(output.receipt.issues).toContain('date_range_incomplete')
    expect(JSON.stringify(output.receipt)).not.toContain('PRIVATE_COLLECTOR_RESPONSE')
  })

  it('retains already collected rows when aborted and makes no subsequent request', async () => {
    const abort = new AbortController()
    const collect = vi.fn(async (_tab: Tab, range: CardDateRange) => {
      abort.abort()
      return result(range)
    })
    const output = await collectRecentCard({
      tab: TAB,
      collect,
      range: RANGE,
      signal: abort.signal
    })
    expect(collect).toHaveBeenCalledTimes(1)
    expect(output.rows).toHaveLength(1)
    expect(output.receipt.complete).toBe(false)
  })

  it('does not call a collector when already aborted or range exceeds four dates', async () => {
    const collect = vi.fn()
    await expect(
      collectRecentCard({ tab: TAB, collect, range: RANGE, signal: AbortSignal.abort() })
    ).rejects.toThrow()
    await expect(
      collectRecentCard({ tab: TAB, collect, range: { from: '2026-09-28', to: RANGE.to } })
    ).rejects.toThrow()
    expect(collect).not.toHaveBeenCalled()
  })
})

describe('loopback-only private collection save', () => {
  it('posts rows only to the fixed local route and returns only the validated receipt', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(saved({ private_rows: [row()], token: TOKEN })))
      )
    vi.stubGlobal('fetch', fetcher)
    const output = await saveCardCollection(result(), { tokenFile: 'synthetic-token-file' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, request] = fetcher.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8000/api/imports/browser-card')
    expect(request).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Finance-Collector-Token': TOKEN }
    })
    expect(JSON.parse(request.body)).toMatchObject({ rows: [row()], receipt: result().receipt })
    expect(JSON.stringify(output)).not.toContain('PRIVATE_MERCHANT')
    expect(JSON.stringify(output)).not.toContain('SYNTHETIC_APPROVAL')
    expect(JSON.stringify(output)).not.toContain(TOKEN)
  })

  it.each(['', 'short', 'x'.repeat(129), 'has whitespace '.repeat(5)])(
    'rejects invalid local token before sending financial data (%#)',
    async (token) => {
      files.readFile.mockResolvedValue(token)
      const fetcher = vi.fn()
      vi.stubGlobal('fetch', fetcher)
      await expect(
        saveCardCollection(result(), { tokenFile: 'synthetic-token-file' })
      ).rejects.toThrow('Finance collector not configured')
      expect(fetcher).not.toHaveBeenCalled()
    }
  )

  it('refuses oversized token files without reading them', async () => {
    files.stat.mockResolvedValue({ isFile: () => true, size: 2000 })
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(
      saveCardCollection(result(), { tokenFile: 'synthetic-token-file' })
    ).rejects.toThrow('Finance collector not configured')
    expect(files.readFile).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('does not echo private non-success response bodies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('PRIVATE_REJECTION', { status: 403 }))
    )
    await expect(
      saveCardCollection(result(), { tokenFile: 'synthetic-token-file' })
    ).rejects.toThrow('Finance collector save rejected')
  })

  it('sends an incomplete collection unchanged for raw retention and review', async () => {
    const collection = result(RANGE, [row()], { complete: false, issues: ['authentication_required'] })
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(saved({ complete: false, status: 'needs_review', inserted_rows: 0, review_rows: 1 }))))
    vi.stubGlobal('fetch', fetcher)
    const output = await saveCardCollection(collection, { tokenFile: 'synthetic-token-file' })
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject(collection)
    expect(output).toMatchObject({ complete: false, status: 'needs_review', inserted_rows: 0, review_rows: 1 })
  })

  it('rejects a receipt for another issuer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(saved({ source: 'samsung_card' }))))
    )
    await expect(
      saveCardCollection(result(), { tokenFile: 'synthetic-token-file' })
    ).rejects.toThrow('Finance collector receipt invalid')
  })

  it('normalizes malformed JSON errors rather than returning response excerpts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('PRIVATE_MERCHANT is not JSON')))
    await expect(
      saveCardCollection(result(), { tokenFile: 'synthetic-token-file' })
    ).rejects.toThrow('Finance collector receipt invalid')
  })

  it('stops reading oversized receipts before draining later chunks', async () => {
    let cancelled = false
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        if (pulls === 1) controller.enqueue(new TextEncoder().encode('x'.repeat(20000)))
        else if (pulls === 2) controller.enqueue(new TextEncoder().encode('PRIVATE_UNREAD_BODY'))
        else controller.close()
      },
      cancel() {
        cancelled = true
      }
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)))
    await expect(
      saveCardCollection(result(), { tokenFile: 'synthetic-token-file' })
    ).rejects.toThrow('Finance collector receipt invalid')
    expect(cancelled).toBe(true)
    expect(pulls).toBeLessThan(3)
  })

  it('does not let transport error messages containing private data escape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('PRIVATE_TRANSPORT_RESPONSE')))
    const failure = await saveCardCollection(result(), { tokenFile: 'synthetic-token-file' }).catch(
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).not.toContain('PRIVATE_TRANSPORT_RESPONSE')
  })

  it('does not expose local token paths from filesystem errors', async () => {
    files.readFile.mockRejectedValue(new Error('PRIVATE_LOCAL_TOKEN_PATH'))
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const failure = await saveCardCollection(result(), { tokenFile: 'synthetic-token-file' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).not.toContain('PRIVATE_LOCAL_TOKEN_PATH')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
