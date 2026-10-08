import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../src/main/browser/tab-manager'
import { pageBridge } from '../src/main/browser/page-bridge'
import {
  collectHyundaiCancellationApi,
  parseHyundaiCancellationPage
} from '../src/main/finance/hyundai-cancellation-collector'
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../src/main/finance/hyundai-api-collector', async (original) => ({
  ...(await original<object>()),
  requestHyundaiApiPage: mocks.request
}))
afterEach(() => {
  vi.restoreAllMocks()
  mocks.request.mockReset()
})
const day = '2026-10-07'
const raw = (changes = {}): object => ({
  useDt: '20261007',
  avDt: '20260801',
  avDttm: '20260801120000',
  avNo: 'SYNTHETIC_APPROVAL',
  useAmt: '3000',
  excm: '0',
  cancYn: 'Y',
  calnMarkVl: '-',
  slipNo: 'SYNTHETIC_REFUND_SLIP',
  crno: 'CARD_A',
  cdno: '0000000000001234',
  cardNm: '합성 카드',
  mrchNm: '합성 상점',
  ...changes
})
const form = (date = day, crno = 'ALL'): Record<string, string> => ({
  crno,
  dmfrClsf: '',
  dtClsf: 'CUSTOM',
  endDt: date.replaceAll('-', ''),
  listClsf: 'ACQUIRED',
  sortType: 'DATE',
  srtDt: date.replaceAll('-', ''),
  useClsf: 'ALL',
  usplClsf: 'ALL',
  zoneClsf: 'ALL'
})
const payload = (items: object[], total = items.length, query = form()): object => ({
  bdy: {
    rcntSummaryInfo: { totUseCnt: total, ...query },
    acqrUseItmList: items
  }
})
function fixture(): Tab {
  vi.spyOn(pageBridge, 'hyundaiAuth').mockResolvedValue({ state: 'signed_in' })
  return {
    profile: 'default',
    view: {
      webContents: {
        getURL: () => 'https://www.hyundaicard.com/cpa/cb/CPACB0101_01.hc',
        isDestroyed: () => false,
        executeJavaScript: vi.fn(async (script: string) => ({
          ok: true,
          data: form(script.match(/"(\d{4}-\d{2}-\d{2})"/)?.[1]),
          cardTails: [
            { crno: 'CARD_A', status: 'matched', queryable: true, last4: '1234' },
            { crno: 'CARD_B', status: 'matched', queryable: true, last4: '5678' }
          ]
        }))
      }
    }
  } as unknown as Tab
}
describe('Hyundai acquired refund collection', () => {
  it('keeps the refund amount separate from the unknown original gross and dates', () => {
    const page = parseHyundaiCancellationPage(
      payload([raw(), raw({ cancYn: 'N', calnMarkVl: '', slipNo: 'POSITIVE' })]),
      day
    )
    expect(page.covered).toBe(true)
    expect(page.rows).toHaveLength(1)
    expect(page.rows[0]).toMatchObject({
      amount: 0,
      originalAmountKnown: false,
      cancellationAmount: 3000,
      approvedAt: '2026-08-01T12:00:00+09:00',
      queryDate: day,
      eventDate: day,
      cancellationAmountType: 'event',
      cancellationEvidence: false
    })
    expect(page.rows[0].cancellationEventId).toMatch(/^[a-f0-9]{64}$/)
  })
  it('requires stable repeated official responses before giving individual proof', async () => {
    mocks.request.mockResolvedValue(payload([raw()]))
    const result = await collectHyundaiCancellationApi(fixture(), { from: day, to: day })
    expect(mocks.request).toHaveBeenCalledTimes(2)
    expect(result.receipt).toMatchObject({
      cancellationQueryComplete: true,
      cancellationQueryBasis: 'issuer_display_date',
      approvalComplete: false,
      cancellationComplete: false,
      statusComplete: false
    })
    expect(result.rows[0].cancellationEvidence).toBe(true)
  })
  it('uses the official acquired merchant field instead of an unrelated approval alias', () => {
    const row = parseHyundaiCancellationPage(
      payload([raw({ useMrchNm: '관련 없는 승인 표시명' })]),
      day
    ).rows[0]
    expect(row.merchant).toBe('합성 상점')
    expect(row.needsReview).not.toContain('merchant_source_unverified')
  })
  it('never replaces a missing acquired merchant with an unverified approval alias', async () => {
    mocks.request.mockResolvedValue(payload([raw({ mrchNm: '', useMrchNm: '검증되지 않은 상점' })]))
    const result = await collectHyundaiCancellationApi(fixture(), { from: day, to: day })
    expect(result.rows[0]?.cancellationEvidence).not.toBe(true)
  })
  it('does not prove a changing refund snapshot', async () => {
    mocks.request
      .mockResolvedValueOnce(payload([raw()]))
      .mockResolvedValueOnce(payload([raw({ useAmt: 3500 })]))
    const result = await collectHyundaiCancellationApi(fixture(), { from: day, to: day })
    expect(result.receipt.cancellationQueryComplete).toBe(false)
    expect(result.rows[0].cancellationEvidence).toBe(false)
  })
  it.each([{ calnMarkVl: '+' }, { slipNo: '' }, { excm: '' }, { useDt: '20261006' }])(
    'rejects unproved refund data %j',
    async (change) => {
      mocks.request.mockResolvedValue(payload([raw(change)]))
      const result = await collectHyundaiCancellationApi(fixture(), { from: day, to: day })
      expect(result.rows[0]?.cancellationEvidence).not.toBe(true)
    }
  )
  it('never treats a duplicate refund ID or missing row as complete', () => {
    expect(parseHyundaiCancellationPage(payload([raw(), raw()]), day).covered).toBe(false)
    expect(parseHyundaiCancellationPage(payload([raw()], 2), day).covered).toBe(false)
  })
  it('emits only the negative event when a cancelled original shares its slip', async () => {
    mocks.request.mockResolvedValue(payload([raw({ calnMarkVl: '' }), raw()]))
    const result = await collectHyundaiCancellationApi(fixture(), { from: day, to: day })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].cancellationAmount).toBe(3000)
    expect(result.rows[0].cancellationEvidence).toBe(true)
    expect(result.receipt.cancellationQueryComplete).toBe(true)
  })
  it('withholds proof from both negative rows sharing the same refund slip', async () => {
    mocks.request.mockResolvedValue(payload([raw(), raw({ useAmt: 3500 })]))
    const result = await collectHyundaiCancellationApi(fixture(), { from: day, to: day })
    expect(result.rows).toHaveLength(2)
    expect(result.rows.every((row) => row.needsReview.includes('duplicate_source_identity'))).toBe(
      true
    )
    expect(result.rows.every((row) => !row.cancellationEvidence)).toBe(true)
    expect(result.receipt.cancellationQueryComplete).toBe(false)
  })
  it('splits a capped all-card day and validates every card total twice', async () => {
    const a = Array.from({ length: 350 }, (_, i) => raw({ avNo: `A${i}`, slipNo: `A_SLIP_${i}` }))
    const b = Array.from({ length: 350 }, (_, i) =>
      raw({ crno: 'CARD_B', cdno: '0000000000005678', avNo: `B${i}`, slipNo: `B_SLIP_${i}` })
    )
    mocks.request.mockImplementation(async (_tab, query) =>
      payload(
        query.crno === 'ALL' ? [...a, ...b].slice(0, 630) : query.crno === 'CARD_A' ? a : b,
        query.crno === 'ALL' ? 700 : 350,
        query
      )
    )
    const result = await collectHyundaiCancellationApi(fixture(), { from: day, to: day })
    expect(result.rows).toHaveLength(700)
    expect(result.receipt.cancellationQueryComplete).toBe(true)
    expect(result.receipt.issues).toContain('card_split_verified')
    expect(mocks.request).toHaveBeenCalledTimes(6)
  })
  it('retains incomplete status when even one individual card hits the cap', async () => {
    const a = Array.from({ length: 640 }, (_, i) => raw({ avNo: `A${i}`, slipNo: `SLIP_${i}` }))
    mocks.request.mockImplementation(async (_tab, query) =>
      payload(
        query.crno === 'CARD_B' ? [] : a.slice(0, 630),
        query.crno === 'CARD_B' ? 0 : 640,
        query
      )
    )
    const result = await collectHyundaiCancellationApi(fixture(), { from: day, to: day })
    expect(result.receipt.cancellationQueryComplete).toBe(false)
    expect(result.rows.every((row) => !row.cancellationEvidence)).toBe(true)
  })
  it('does not issue requests for an excessive range or an aborted session', async () => {
    const tab = fixture()
    expect(
      (await collectHyundaiCancellationApi(tab, { from: '2026-10-01', to: day })).receipt
        .cancellationQueryComplete
    ).toBe(false)
    const controller = new AbortController()
    controller.abort()
    expect(
      (
        await collectHyundaiCancellationApi(
          tab,
          { from: day, to: day },
          { signal: controller.signal }
        )
      ).receipt.cancellationQueryComplete
    ).toBe(false)
    expect(mocks.request).not.toHaveBeenCalled()
  })
})
