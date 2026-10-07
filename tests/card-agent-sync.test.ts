import { EventEmitter } from 'node:events'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../src/main/browser/tab-manager'
import type { CardApiResult } from '../src/main/finance/card-api-types'

const mocks = vi.hoisted(() => ({
  stat: vi.fn(),
  readFile: vi.fn(),
  session: vi.fn(),
  hyundaiAuth: vi.fn(),
  collect: vi.fn(),
  save: vi.fn(),
  samsung: vi.fn(),
  lotte: vi.fn(),
  hyundai: vi.fn()
}))
vi.mock('node:fs/promises', () => ({ stat: mocks.stat, readFile: mocks.readFile }))
vi.mock('../src/main/browser/page-bridge', () => ({
  pageBridge: { cardSession: mocks.session, hyundaiAuth: mocks.hyundaiAuth }
}))
vi.mock('../src/main/finance/card-sync', () => ({
  collectRecentCard: mocks.collect,
  saveCardCollection: mocks.save
}))
vi.mock('../src/main/finance/samsung-api-collector', () => ({ collectSamsungApi: mocks.samsung }))
vi.mock('../src/main/finance/lotte-api-collector', () => ({ collectLotteApi: mocks.lotte }))
vi.mock('../src/main/finance/hyundai-api-collector', () => ({ collectHyundaiApi: mocks.hyundai }))

import {
  createCardAgentSync,
  CARD_AGENT_SYNC_TIMEOUT_MS
} from '../src/main/finance/card-agent-sync'
import { CARD_HISTORY_URLS } from '../src/main/finance/card-page-diagnostics'
import { parseSettings } from '../src/shared/settings'
import { SYNCED_SETTING_KEYS } from '../src/shared/sync'

const tokenFile = 'C:/private/finance-token'
const secret = 'a'.repeat(64)
const range = { from: '2026-09-29', to: '2026-10-02' }
const privateResult: CardApiResult = {
  rows: [
    {
      issuer: 'samsung_card',
      sourceId: 'PRIVATE-ID',
      kind: 'approval',
      approvedAt: '2026-10-02T09:00:00+09:00',
      merchant: 'PRIVATE-MERCHANT',
      amount: 999999,
      currency: 'KRW',
      status: 'approved',
      cancellationAmount: 0,
      netAmount: 999999,
      needsReview: []
    }
  ],
  receipt: {
    issuer: 'samsung_card',
    range,
    pages: 8,
    rowCount: 1,
    complete: true,
    issues: ['PRIVATE-ISSUE'],
    elapsedMs: 100
  }
}
const saved = {
  batch_id: 'PRIVATE-ID',
  source: 'samsung_card',
  duplicate_batch: false,
  total_rows: 1,
  inserted_rows: 1,
  updated_rows: 0,
  skipped_rows: 0,
  review_rows: 0,
  complete: true,
  status: 'completed',
  range,
  pages: 8,
  rows: privateResult.rows
}

function tabAt(initial = CARD_HISTORY_URLS.samsung_card): {
  tab: Tab
  wc: EventEmitter & { getURL: () => string; isDestroyed: () => boolean }
  navigate: (url: string) => void
} {
  let url = initial
  const wc = Object.assign(new EventEmitter(), {
    getURL: () => url,
    isDestroyed: () => false
  })
  return {
    tab: { view: { webContents: wc } } as unknown as Tab,
    wc,
    navigate: (next) => {
      url = next
      wc.emit('did-start-navigation', {}, next, false, true)
    }
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-01T15:30:00Z'))
  mocks.stat.mockResolvedValue({ isFile: () => true, size: 64 })
  mocks.readFile.mockResolvedValue(secret)
  mocks.session.mockResolvedValue({ issuer: 'samsung_card', state: 'signed_in' })
  mocks.collect.mockResolvedValue(privateResult)
  mocks.save.mockResolvedValue(saved)
})
afterEach(() => vi.useRealTimers())

describe('permanent finance sync configuration', () => {
  it('enables explicit SSH without a local token and rejects unknown destinations', async () => {
    expect(await createCardAgentSync({ transport: 'server-ssh' })).toBeTypeOf('function')
    expect(await createCardAgentSync({ transport: 'server-ssh-typo', tokenFile })).toBeUndefined()
    expect(mocks.stat).not.toHaveBeenCalled()
    expect(mocks.readFile).not.toHaveBeenCalled()
    expect(parseSettings({ financeCollectorTransport: 'wrong' }).financeCollectorTransport).toBe(
      'disabled'
    )
    expect(SYNCED_SETTING_KEYS).not.toContain('financeCollectorTransport')
  })
  it('defaults to disabled and does not cloud-sync the local token path', () => {
    expect(parseSettings({}).financeCollectorTokenFile).toBe('')
    expect(parseSettings({ financeCollectorTokenFile: tokenFile }).financeCollectorTokenFile).toBe(
      tokenFile
    )
    expect(SYNCED_SETTING_KEYS).not.toContain('financeCollectorTokenFile')
  })

  it('registers only for a configured absolute valid token file', async () => {
    expect(await createCardAgentSync({})).toBeUndefined()
    expect(await createCardAgentSync({ tokenFile: 'relative-token' })).toBeUndefined()
    expect(mocks.stat).not.toHaveBeenCalled()
    mocks.stat.mockRejectedValueOnce(new Error(tokenFile + secret))
    expect(await createCardAgentSync({ tokenFile })).toBeUndefined()
    mocks.readFile.mockResolvedValueOnce('invalid')
    expect(await createCardAgentSync({ tokenFile })).toBeUndefined()
    expect(await createCardAgentSync({ tokenFile })).toBeTypeOf('function')
  })
})

describe('deterministic current-card sync', () => {
  it('uses the fixed four KST calendar days and returns only counts', async () => {
    const { tab, wc } = tabAt()
    const run = (await createCardAgentSync({ tokenFile }))!
    const out = await run(tab)
    expect(mocks.collect).toHaveBeenCalledWith({
      tab,
      collect: mocks.samsung,
      range,
      signal: expect.any(AbortSignal)
    })
    expect(mocks.save).toHaveBeenCalledWith(privateResult, {
      tokenFile,
      transport: undefined,
      signal: expect.any(AbortSignal)
    })
    expect(out).toEqual({
      ok: true,
      issuer: 'samsung_card',
      range,
      pages: 8,
      totalRows: 1,
      insertedRows: 1,
      updatedRows: 0,
      skippedRows: 0,
      reviewRows: 0,
      duplicateBatch: false,
      complete: true,
      approvalComplete: false,
      cancellationComplete: false
    })
    const raw = JSON.stringify(out)
    for (const value of ['PRIVATE', '999999', secret, tokenFile, 'rows', 'issues'])
      expect(raw).not.toContain(value)
    expect(wc.listenerCount('did-start-navigation')).toBe(0)
    expect(wc.listenerCount('destroyed')).toBe(0)
  })

  it.each([
    'https://www.samsungcard.com/personal/login/UHPPCO0301M0.jsp',
    'http://www.samsungcard.com/personal/card/activity/UHPPRP0801M0.jsp',
    'https://www.samsungcard.com.attacker.test/personal/card/activity/UHPPRP0801M0.jsp',
    'https://www.samsungcard.com:8443/personal/card/activity/UHPPRP0801M0.jsp'
  ])('rejects non-history or non-exact secure origins: %s', async (url) => {
    const run = (await createCardAgentSync({ tokenFile }))!
    expect(await run(tabAt(url).tab)).toEqual({ ok: false, reason: 'history_page_required' })
    expect(mocks.session).not.toHaveBeenCalled()
    expect(mocks.collect).not.toHaveBeenCalled()
  })

  it('requires an authenticated matching issuer and never attempts login itself', async () => {
    const run = (await createCardAgentSync({ tokenFile }))!
    for (const session of [
      { issuer: 'samsung_card', state: 'signed_out' },
      { issuer: 'lotte_card', state: 'signed_in' }
    ]) {
      mocks.session.mockResolvedValueOnce(session)
      expect(await run(tabAt().tab)).toEqual({ ok: false, reason: 'login_required' })
    }
    expect(mocks.collect).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('dispatches Lotte separately and preserves incomplete review-only receipts', async () => {
    const { tab } = tabAt(CARD_HISTORY_URLS.lotte_card)
    mocks.session.mockResolvedValue({ issuer: 'lotte_card', state: 'signed_in' })
    mocks.collect.mockResolvedValue({
      rows: privateResult.rows,
      receipt: { ...privateResult.receipt, issuer: 'lotte_card', complete: false }
    })
    mocks.save.mockResolvedValue({
      ...saved,
      source: 'lotte_card',
      complete: false,
      inserted_rows: 0,
      review_rows: 1
    })
    const run = (await createCardAgentSync({ tokenFile }))!
    expect(await run(tab)).toMatchObject({
      ok: true,
      complete: false,
      insertedRows: 0,
      reviewRows: 1
    })
    expect(mocks.collect.mock.calls[0][0].collect).toBe(mocks.lotte)
  })

  it('does not save a failed empty query as a successful empty ledger', async () => {
    mocks.collect.mockResolvedValue({
      rows: [],
      receipt: {
        ...privateResult.receipt,
        rowCount: 0,
        complete: false,
        approvalComplete: false,
        issues: ['service_error']
      }
    })
    const run = (await createCardAgentSync({ tokenFile }))!
    expect(await run(tabAt().tab)).toEqual({ ok: false, reason: 'collection_incomplete' })
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('uses the separate Hyundai authenticated-session gate and collector', async () => {
    const { tab } = tabAt(CARD_HISTORY_URLS.hyundai_card)
    mocks.hyundaiAuth.mockResolvedValue({ state: 'signed_in' })
    mocks.collect.mockResolvedValue({
      rows: [],
      receipt: { ...privateResult.receipt, issuer: 'hyundai_card' }
    })
    mocks.save.mockResolvedValue({ ...saved, source: 'hyundai_card' })
    const run = (await createCardAgentSync({ tokenFile }))!
    expect(await run(tab)).toMatchObject({ ok: true, issuer: 'hyundai_card' })
    expect(mocks.collect.mock.calls[0][0].collect).toBe(mocks.hyundai)
    expect(mocks.session).not.toHaveBeenCalled()
  })

  it('does not save if navigation changes during collection', async () => {
    const view = tabAt()
    mocks.collect.mockImplementation(async () => {
      view.navigate('https://www.samsungcard.com/personal/login/UHPPCO0301M0.jsp')
      return privateResult
    })
    const run = (await createCardAgentSync({ tokenFile }))!
    expect(await run(view.tab)).toEqual({ ok: false, reason: 'interrupted' })
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('blocks concurrent calls and late saves after the internal deadline', async () => {
    const view = tabAt()
    let resolve!: (value: CardApiResult) => void
    mocks.collect.mockReturnValue(
      new Promise<CardApiResult>((r) => {
        resolve = r
      })
    )
    const run = (await createCardAgentSync({ tokenFile }))!
    const pending = run(view.tab)
    await Promise.resolve()
    expect(await run(view.tab)).toEqual({ ok: false, reason: 'already_running' })
    await vi.advanceTimersByTimeAsync(CARD_AGENT_SYNC_TIMEOUT_MS)
    expect(await pending).toEqual({ ok: false, reason: 'interrupted' })
    expect(mocks.collect.mock.calls[0][0].signal.aborted).toBe(true)
    resolve(privateResult)
    await Promise.resolve()
    expect(mocks.save).not.toHaveBeenCalled()
    expect(view.wc.listenerCount('did-start-navigation')).toBe(0)
  })

  it('respects agent stop and masks exceptions', async () => {
    const abort = new AbortController()
    const run = (await createCardAgentSync({ tokenFile, signal: abort.signal }))!
    mocks.session.mockRejectedValueOnce(new Error('PRIVATE-MERCHANT ' + secret + tokenFile))
    expect(await run(tabAt().tab)).toEqual({ ok: false, reason: 'sync_unavailable' })
    abort.abort()
    expect(await run(tabAt().tab)).toEqual({ ok: false, reason: 'interrupted' })
    expect(mocks.collect).not.toHaveBeenCalled()
  })

  it('rejects a collector returning the wrong date range before saving', async () => {
    mocks.collect.mockResolvedValue({
      ...privateResult,
      receipt: { ...privateResult.receipt, range: { from: '2026-09-01', to: '2026-10-02' } }
    })
    const run = (await createCardAgentSync({ tokenFile }))!
    expect(await run(tabAt().tab)).toEqual({ ok: false, reason: 'sync_unavailable' })
    expect(mocks.save).not.toHaveBeenCalled()
  })
})
