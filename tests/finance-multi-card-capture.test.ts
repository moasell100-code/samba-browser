import { afterEach, describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { captureFinanceTables } from '../src/preload/page-finance'
import {
  financeCardIssuer,
  financeFrameCaptureSchema,
  financePageCaptureSchema,
  isFinanceCaptureUrl
} from '../src/main/finance/capture-schema'
import { FinanceCaptureStore } from '../src/main/finance/capture-store'
import type { FinanceFrameCapture } from '../src/shared/finance-capture'

const windows: JSDOM[] = []
function documentAt(url: string, html: string): Document {
  const dom = new JSDOM(html, { url })
  windows.push(dom)
  return dom.window.document
}

afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close()
})

const issuers = [
  ['https://www.hyundaicard.com', 'hyundai_card'],
  ['https://hyundaicard.com', 'hyundai_card'],
  ['https://www.samsungcard.com', 'samsung_card'],
  ['https://www.lottecard.co.kr', 'lotte_card']
] as const

describe('official card capture boundaries', () => {
  it('retains ordered Lotte cancellation amounts without treating them as reconciled expenses', () => {
    const fields = [
      'name',
      'date',
      'card',
      'payment_type',
      'cancellation_status',
      'amount',
      'secondary_amount'
    ] as const
    const frame: FinanceFrameCapture = {
      origin: 'https://www.lottecard.co.kr',
      pathname: '/app/LPMCDAA_V100.lc',
      tables: [],
      lists: [
        {
          adapter: 'lotte_history_list_v1',
          hiddenRows: 0,
          unrecognizedRows: 0,
          hasMore: false,
          rows: [
            {
              head: fields.map((field, index) => ({
                field,
                text: [
                  'private name',
                  '2026.09.17',
                  'private card',
                  '일시불',
                  '부분취소',
                  '12,345원',
                  '3,456원'
                ][index]
              })),
              details: [],
              detailsVisible: false
            }
          ]
        }
      ]
    }
    expect(financeFrameCaptureSchema.safeParse(frame).success).toBe(true)
    const store = new FinanceCaptureStore()
    const receipt = store.save({ frames: [frame], failedFrames: 0, skippedFrames: 0 })
    expect(receipt.listRowCount).toBe(1)
    expect(receipt.issues).toContain('cancellation_amount_review')
    expect(receipt.listSummaries?.[0].nonemptyFields).toContainEqual({
      field: 'secondary_amount',
      count: 1
    })
    expect(JSON.stringify(receipt)).not.toMatch(/private|12,345|3,456|부분취소/)
    expect(
      store
        .readForReview(receipt.captureId)
        ?.page.frames[0].lists?.[0].rows[0].head.slice(-2)
        .map(({ text }) => text)
    ).toEqual(['12,345원', '3,456원'])
    for (const status of ['승인', '취소', 'unknown']) {
      const invalid = structuredClone(frame)
      invalid.lists![0].rows[0].head[4].text = status
      expect(financeFrameCaptureSchema.safeParse(invalid).success).toBe(false)
    }
    const otherIssuer = structuredClone(frame)
    otherIssuer.origin = 'https://www.samsungcard.com'
    otherIssuer.pathname = '/personal/card/activity/UHPPRP0801D0.jsp'
    otherIssuer.lists![0].adapter = 'samsung_history_list_v1'
    expect(financeFrameCaptureSchema.safeParse(otherIssuer).success).toBe(false)
    store.clear()
  })

  it('carries the verified Lotte list through the schema and returns counts without its cells', () => {
    const doc = documentAt(
      'https://www.lottecard.co.kr/app/LPMCDAA_V100.lc',
      `<ul id="useCardList" class="useCardList type02"><li class="toggle">
      <strong>private merchant</strong><div class="info"><span>2026.09.17</span>
      <span>private card</span><span>일시불</span></div><em><span>12,345원</span></em>
      <div class="useList" hidden>private detail</div></li></ul><button>더보기</button>`
    )
    const frame = captureFinanceTables(doc)
    expect(financeFrameCaptureSchema.safeParse(frame).success).toBe(true)
    expect(frame.lists?.[0].adapter).toBe('lotte_history_list_v1')
    expect(frame.lists?.[0].rows[0].head.map(({ field }) => field)).toEqual([
      'name',
      'date',
      'card',
      'payment_type',
      'amount'
    ])
    const receipt = new FinanceCaptureStore().save({
      frames: [frame],
      failedFrames: 0,
      skippedFrames: 0
    })
    expect(receipt.issuer).toBe('lotte_card')
    expect(receipt.listRowCount).toBe(1)
    expect(receipt.issues).toContain('details_incomplete')
    expect(receipt.issues).toContain('more_rows_available')
    expect(JSON.stringify(receipt)).not.toMatch(/private|12,345|2026\.09\.17/)
    expect(
      financeFrameCaptureSchema.safeParse({ ...frame, origin: 'https://www.samsungcard.com' })
        .success
    ).toBe(false)
    expect(
      financeFrameCaptureSchema.safeParse({ ...frame, pathname: '/app/LPMANAA_V200.lc' }).success
    ).toBe(false)
  })

  it.each(issuers)('preserves raw cells from %s and returns only %s metadata', (origin, issuer) => {
    const url = `${origin}/history?account=private-query`
    const doc = documentAt(
      url,
      `
      <table><tr><th>승인번호</th><th>승인금액</th><th>상태</th></tr>
      <tr><td>00123456</td><td>12,345 원</td><td>부분취소</td></tr>
      <tr><td>private merchant <input value="private-input"><span hidden>private-hidden</span></td></tr>
      </table>`
    )
    expect(financeCardIssuer(url)).toBe(issuer)
    expect(isFinanceCaptureUrl(url)).toBe(true)
    const captured = captureFinanceTables(doc)
    expect(captured.tables[0].rows[1].map((cell) => cell.text)).toEqual([
      '00123456',
      '12,345 원',
      '부분취소'
    ])
    expect(JSON.stringify(captured)).not.toMatch(/private-query|private-input|private-hidden/)
    const store = new FinanceCaptureStore()
    const receipt = store.save({ frames: [captured], failedFrames: 0, skippedFrames: 0 })
    expect(receipt.issuer).toBe(issuer)
    expect(receipt.previewOnly).toBe(true)
    expect(receipt.issues).toContain('site_adapter_unverified')
    expect(JSON.stringify(receipt)).not.toMatch(/private|00123456|12,345|부분취소/)
    store.clear()
  })

  it.each([
    'http://www.samsungcard.com/',
    'https://samsungcard.com/',
    'https://www.samsungcard.com.evil.test/',
    'https://login.samsungcard.com/',
    'https://www.samsungcard.com:8443/',
    'https://user:secret@www.samsungcard.com/',
    'http://www.lottecard.co.kr/',
    'https://lottecard.co.kr/',
    'https://www.lottecard.co.kr.evil.test/',
    'https://login.lottecard.co.kr/',
    'https://www.lottecard.co.kr:8443/',
    'https://user:secret@www.lottecard.co.kr/',
    'file:///www.lottecard.co.kr/'
  ])('rejects unverified card endpoints: %s', (url) => {
    expect(financeCardIssuer(url)).toBeNull()
    expect(isFinanceCaptureUrl(url)).toBe(false)
    const doc = documentAt(url, '<table><tr><td>private</td></tr></table>')
    expect(() => captureFinanceTables(doc)).toThrow('finance_origin_not_allowed')
  })

  it('does not expose the Hyundai-only layout diagnostic on other issuers', () => {
    for (const origin of ['https://www.samsungcard.com', 'https://www.lottecard.co.kr']) {
      const captured = captureFinanceTables(
        documentAt(
          `${origin}/cpa/cb/CPACB0101_01.hc`,
          '<div id="divHistoryUseRight" class="irrelevant"></div>'
        )
      )
      expect(captured.layoutDiagnostic).toBeUndefined()
      expect(
        financeFrameCaptureSchema.safeParse({
          ...captured,
          layoutDiagnostic: {
            nodes: [{ depth: 0, tag: 'div', classes: ['irrelevant'] }],
            truncated: false
          }
        }).success
      ).toBe(false)
    }
  })

  it('rejects an origin field containing a pathname or private query', () => {
    expect(
      financeFrameCaptureSchema.safeParse({
        origin: 'https://www.samsungcard.com/history?account=private-query',
        pathname: '/history',
        tables: []
      }).success
    ).toBe(false)
  })

  it('rejects cross-issuer frame mixtures rather than attributing them to the main card', () => {
    const frame = (origin: string): FinanceFrameCapture => ({
      origin,
      pathname: '/history',
      tables: []
    })
    const store = new FinanceCaptureStore()
    for (const [origin] of issuers.filter(([, issuer]) => issuer !== 'hyundai_card')) {
      const mixed = {
        frames: [frame('https://www.hyundaicard.com'), frame(origin)],
        failedFrames: 0,
        skippedFrames: 0
      }
      expect(financePageCaptureSchema.safeParse(mixed).success).toBe(false)
      expect(() => store.save(mixed)).toThrow('finance_capture_invalid')
    }
    expect(
      financePageCaptureSchema.safeParse({
        frames: [frame('https://www.hyundaicard.com'), frame('https://hyundaicard.com')],
        failedFrames: 0,
        skippedFrames: 0
      }).success
    ).toBe(true)
  })
})
