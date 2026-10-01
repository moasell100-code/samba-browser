import { afterEach, describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { captureFinanceTables, FINANCE_CAPTURE_LIMITS } from '../src/preload/page-finance'
import { FinanceCaptureStore } from '../src/main/finance/capture-store'
import { financeFrameCaptureSchema } from '../src/main/finance/capture-schema'
import type { FinanceCaptureReceipt, FinanceFrameCapture } from '../src/shared/finance-capture'

const path = '/personal/card/activity/UHPPRP0801M0.jsp'
const windows: JSDOM[] = []
function docAt(html: string, url = `https://www.samsungcard.com${path}`): Document {
  const dom = new JSDOM(html, { url })
  windows.push(dom)
  return dom.window.document
}
afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close()
})

// Synthetic data using the site's public D0.jsp row template, not user data.
function row(detailsStyle = ''): string {
  return `<li class="li rowList" data-card="attribute-secret">
    <div class="head"><div class="fl_l">
      <p class="name"><span class="ico ico_bonus"><span class="hide">bonus-secret</span></span><span>합성상점</span></p>
      <p class="td first"><span class="hide">승인일자</span><strong>2026.10.01</strong></p>
      <p class="td second"><span class="hide">승인시간</span><span>12:34:56</span></p>
      <p class="td last"><span>테스트 9876</span> / <span>일시불</span></p>
    </div><div class="fl_r"><p class="em"><strong class="f_ls0">-12,345</strong>원</p>
      <div class="state_area"><button>금융 버튼 secret</button></div>
    </div><button class="btn_open ui_accord_toggle" onclick="private-secret">상세 내용 더 보기</button></div>
    <div class="desc_wrap ui_accord_content desc_banner_vin08" style="${detailsStyle}"><ul class="row">
      <li><span class="fl_l">승인번호</span><span class="fl_r">00123456</span></li>
      <li><span class="fl_l">취소여부</span><span class="fl_r">취소</span></li>
      <li><span class="fl_l">취소접수일</span><span class="fl_r">2026.10.02</span></li>
      <li hidden><span class="fl_l">hidden-secret</span><span class="fl_r">hidden-value-secret</span></li>
    </ul><input value="input-secret"><div class="bt_wrap"><button>private-action-secret</button></div></div>
  </li>`
}

function capture(html: string): FinanceFrameCapture {
  return captureFinanceTables(docAt(`<style>.hide{display:none}</style>${html}`))
}

function receiptOf(frame: FinanceFrameCapture): FinanceCaptureReceipt {
  const store = new FinanceCaptureStore()
  const receipt = store.save({ frames: [frame], failedFrames: 0, skippedFrames: 0 })
  store.clear()
  return receipt
}

describe('Samsung visible history list adapter', () => {
  it('preserves head columns, detail label/value boundaries and the visible approval number', () => {
    const frame = capture(`<ul id="inquire_append">${row()}</ul>`)
    expect(frame.tables).toEqual([])
    expect(frame.lists).toHaveLength(1)
    expect(frame.lists![0]).toEqual({
      adapter: 'samsung_history_list_v1',
      hiddenRows: 0,
      unrecognizedRows: 0,
      hasMore: false,
      rows: [
        {
          head: [
            { field: 'name', text: '합성상점' },
            { field: 'date', text: '2026.10.01' },
            { field: 'time', text: '12:34:56' },
            { field: 'card', text: '테스트 9876' },
            { field: 'payment_type', text: '일시불' },
            { field: 'amount', text: '-12,345' }
          ],
          details: [
            { label: '승인번호', value: '00123456' },
            { label: '취소여부', value: '취소' },
            { label: '취소접수일', value: '2026.10.02' }
          ],
          detailsVisible: true,
          sourceRowId: '00123456'
        }
      ]
    })
    expect(JSON.stringify(frame)).not.toContain('secret')
    const receipt = receiptOf(frame)
    expect(receipt.issuer).toBe('samsung_card')
    expect(receipt.rowCount).toBe(0)
    expect(receipt.tableCount).toBe(0)
    expect(receipt.listCount).toBe(1)
    expect(receipt.listRowCount).toBe(1)
    expect(receipt.issues).not.toContain('no_tables')
    expect(receipt.issues).not.toContain('site_adapter_unverified')
    expect(receipt.issues).toEqual(['query_range_unverified', 'pagination_unverified'])
    expect(JSON.stringify(receipt)).not.toMatch(/합성상점|9876|00123456|12,345|취소/)
  })

  it('omits collapsed details and never invents an approval number from hidden data', () => {
    const frame = capture(`<ul id="inquire_append">${row('display:none')}</ul>`)
    expect(frame.lists![0].rows[0].details).toEqual([])
    expect(frame.lists![0].rows[0].sourceRowId).toBeUndefined()
    expect(JSON.stringify(frame)).not.toContain('00123456')
    expect(receiptOf(frame).issues).toContain('details_incomplete')
  })

  it('reports visible more controls, excludes hidden calendar data and does not inspect control attributes', () => {
    const frame =
      capture(`<ul id="inquire_append">${row()}</ul><button id="btn_more" data-count="private-secret">더보기</button>
      <ul id="clnd_inquire_append" hidden>${row()}</ul><button id="clnd_btn_more" hidden>더보기</button>`)
    expect(frame.lists).toHaveLength(1)
    expect(receiptOf(frame).issues).toContain('more_rows_available')
    const calendar = capture(
      `<ul id="clnd_inquire_append">${row()}</ul><button id="clnd_btn_more">더보기</button>`
    )
    expect(calendar.lists![0].hasMore).toBe(true)
    expect(JSON.stringify(frame)).not.toContain('private-secret')
  })

  it('marks incomplete rows instead of silently fabricating missing head fields', () => {
    const frame = capture(
      `<ul id="inquire_append">${row().replace('<strong class="f_ls0">-12,345</strong>', '')}</ul>`
    )
    expect(frame.lists![0].rows).toEqual([])
    expect(frame.lists![0].unrecognizedRows).toBe(1)
    expect(receiptOf(frame).issues).toEqual(
      expect.arrayContaining(['unrecognized_rows', 'site_adapter_unverified'])
    )
  })

  it('reports hidden rows and malformed expanded detail fields as incomplete', () => {
    const hiddenRow = row().replace('class="li rowList"', 'class="li rowList" hidden')
    const broken = row().replace('<span class="fl_r">00123456</span>', '<span>00123456</span>')
    const frame = capture(`<ul id="inquire_append">${hiddenRow}${broken}</ul>`)
    expect(frame.lists![0].hiddenRows).toBe(1)
    expect(frame.lists![0].rows[0].sourceRowId).toBeUndefined()
    expect(receiptOf(frame).issues).toEqual(
      expect.arrayContaining(['hidden_rows', 'details_incomplete'])
    )
  })

  it.each([
    'https://www.samsungcard.com/personal/login/UHPPCO0301M0.jsp',
    'https://www.samsungcard.com/personal/card/activity/UHPPRP0801D8.jsp',
    'https://www.hyundaicard.com/personal/card/activity/UHPPRP0801M0.jsp',
    'https://www.lottecard.co.kr/personal/card/activity/UHPPRP0801M0.jsp'
  ])('does not apply the adapter on unverified routes or issuers: %s', (url) => {
    const frame = captureFinanceTables(docAt(`<ul id="inquire_append">${row()}</ul>`, url))
    expect(frame.lists).toBeUndefined()
  })

  it('accepts the verified public fragment route and rejects copying its list payload to another issuer', () => {
    const frame = captureFinanceTables(
      docAt(
        `<ul id="inquire_append">${row()}</ul>`,
        'https://www.samsungcard.com/personal/card/activity/UHPPRP0801D0.jsp'
      )
    )
    expect(frame.lists![0].rows).toHaveLength(1)
    expect(financeFrameCaptureSchema.safeParse(frame).success).toBe(true)
    expect(
      financeFrameCaptureSchema.safeParse({ ...frame, origin: 'https://www.lottecard.co.kr' })
        .success
    ).toBe(false)
    expect(financeFrameCaptureSchema.safeParse({ ...frame, pathname: '/unverified' }).success).toBe(
      false
    )
    frame.lists![0].rows[0].sourceRowId = 'fabricated'
    expect(financeFrameCaptureSchema.safeParse(frame).success).toBe(false)
  })

  it('rejects oversized rows and cells rather than returning a partial list', () => {
    expect(() =>
      capture(
        `<ul id="inquire_append">${'<li class="rowList"></li>'.repeat(FINANCE_CAPTURE_LIMITS.rows + 1)}</ul>`
      )
    ).toThrow('finance_capture_limit')
    expect(() =>
      capture(
        `<ul id="inquire_append">${row().replace('합성상점', 'x'.repeat(FINANCE_CAPTURE_LIMITS.cellChars + 1))}</ul>`
      )
    ).toThrow('finance_capture_limit')
  })
})
