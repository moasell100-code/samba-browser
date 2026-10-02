import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { readLotteHistoryLayout } from '../src/preload/page-lotte-history-layout'
import { lotteHistoryLayoutSchema } from '../src/main/finance/lotte-history-layout-schema'

const URL = 'https://www.lottecard.co.kr/app/LPMCDAA_V100.lc'
const windows: JSDOM[] = []
function at(html: string, url = URL): Document {
  const dom = new JSDOM(html, { url })
  windows.push(dom)
  return dom.window.document
}
afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close()
})

describe('bounded Lotte public history shape diagnostic', () => {
  it('adds only the first visible row for each distinct cancellation shape with original row indexes', () => {
    const doc = at(`<ul id="useCardList"><li><strong>normal-private</strong></li>
      <li hidden class="cancel"><em class="parttot">hidden-private</em></li>
      <li class="cancel"><strong>cancel-private</strong><span>취소</span><span>취소 customer-private</span></li>
      <li><em class="cancel"><span>98,765원</span><span>12,300원</span></em></li>
      <li><em class="parttot"><span>23,456원</span><span>1,230원</span></em><div class="useList">
        <dl><dt>승인금액</dt><dd>23,456원</dd><dt>취소금액</dt><dd>1,230원</dd><dt>결제방법</dt><dd>private-payment</dd>
        <dt>승인일시</dt><dd>date-private</dd><dt>취소일시</dt><dd>cancel-date-private</dd><dt>매입일자</dt><dd>date-private</dd></dl>
        <span>부분취소</span><span>승인취소</span><span>부분 취소</span><span hidden>secret-private</span>
      </div></li><li class="cancel"><strong>later-private</strong></li></ul>`)
    const result = readLotteHistoryLayout(doc)
    expect(result.variantSamples?.map(({ variant, rowIndex }) => ({ variant, rowIndex }))).toEqual([
      { variant: 'row_cancel', rowIndex: 2 },
      { variant: 'em_cancel', rowIndex: 3 },
      { variant: 'em_parttot', rowIndex: 4 }
    ])
    const labels = result.variantSamples!.flatMap(({ nodes }) =>
      nodes.flatMap(({ label }) => (label ? [label] : []))
    )
    expect(labels).toEqual([
      '취소',
      '승인금액',
      '취소금액',
      '결제방법',
      '승인일시',
      '취소일시',
      '매입일자',
      '부분취소',
      '승인취소'
    ])
    expect(JSON.stringify(result)).not.toMatch(/private|98,765|12,300|23,456|1,230/)
    expect(lotteHistoryLayoutSchema.safeParse(result).success).toBe(true)
  })
  it('does not duplicate the existing first row and includes the first normal row when needed', () => {
    const result = readLotteHistoryLayout(
      at(
        '<ul id="useCardList"><li class="cancel"><em class="cancel">private</em></li><li><strong>normal-private</strong></li><li class="cancel">later-private</li></ul>'
      )
    )
    expect(result.variantSamples?.map(({ variant, rowIndex }) => ({ variant, rowIndex }))).toEqual([
      { variant: 'normal', rowIndex: 1 }
    ])
  })
  it('enforces independent node/depth limits and excludes inputs in every additional sample', () => {
    const many = '<span>private</span>'.repeat(100)
    const doc = at(
      `<ul id="useCardList"><li>normal</li><li class="cancel">${many}<input type="password" value="secret"></li><li><em class="cancel">${many}</em></li><li><em class="parttot">${'<div>'.repeat(10)}deep-private${'</div>'.repeat(10)}</em></li></ul>`
    )
    vi.spyOn(doc.querySelector('input')!, 'value', 'get').mockImplementation(() => {
      throw new Error('value read')
    })
    const result = readLotteHistoryLayout(doc)
    expect(result.variantSamples).toHaveLength(3)
    expect(
      result.variantSamples!.every(
        ({ nodes, truncated }) =>
          nodes.length <= 80 && nodes.every(({ depth }) => depth <= 6) && truncated
      )
    ).toBe(true)
    expect(result.truncated).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/private|secret/)
    expect(lotteHistoryLayoutSchema.safeParse(result).success).toBe(true)
    expect(
      lotteHistoryLayoutSchema.safeParse({
        ...result,
        variantSamples: [...result.variantSamples!, result.variantSamples![0]]
      }).success
    ).toBe(false)
    expect(
      lotteHistoryLayoutSchema.safeParse({
        ...result,
        variantSamples: [{ ...result.variantSamples![0], text: 'private' }]
      }).success
    ).toBe(false)
  })
  it('describes only one direct row with value kinds, public CSS and list variant counts', () => {
    const doc =
      at(`<p>outside-account-name</p><form><ul id="useCardList" class="useCardList type02">
      <li class="toggle secret-account" id="approval-123456789"><strong>private-merchant</strong>
      <div class="info"><span>2026.10.02</span><span>masked-account-0000</span></div>
      <em class="cancel"><span>93,401원</span><span>22,100원</span></em>
      <div class="useList"><dl><dt>승인번호</dt><dd>approval-private</dd></dl></div></li>
      <li class="toggleON"><strong>second-private-merchant</strong><em class="parttot">900원</em></li>
      <li hidden><strong>hidden-private-merchant</strong></li>
    </ul></form>`)
    const result = readLotteHistoryLayout(doc)
    expect(result.state).toBe('ok')
    expect(result.directRowCount).toBe(2)
    expect(result.variants).toEqual({ cancel: 1, parttot: 1, toggle: 1, toggleON: 1 })
    expect(result.representative?.[0]).toMatchObject({
      tag: 'li',
      classes: ['toggle'],
      omittedClasses: true,
      hasUnlistedId: true,
      visibleChildCount: 4
    })
    expect(result.representative?.filter((node) => node.textKind === 'date_like')).toHaveLength(1)
    expect(result.representative?.filter((node) => node.textKind === 'amount_like')).toHaveLength(2)
    expect(result.representative?.find((node) => node.tag === 'dt')).toMatchObject({
      textKind: 'fixed_label',
      label: '승인번호'
    })
    expect(JSON.stringify(result)).not.toMatch(/private|account|123456789|2026|93,401|22,100|900/)
    expect(lotteHistoryLayoutSchema.safeParse(result).success).toBe(true)
  })
  it('never reads field values, hidden/script/form-control subtrees or arbitrary attributes', () => {
    const doc = at(`<ul id="useCardList"><li><strong>merchant</strong>
      <input type="password" value="secret"><textarea>text-private</textarea><select><option>option-private</option></select>
      <button><span>button-private</span></button><div hidden>hidden-private</div><span aria-hidden="true">aria-private</span>
      <script>script-private</script><style>style-private</style><div contenteditable>edit-private</div>
      <span class="info" data-account="attribute-private">leaf-private</span>
    </li></ul>`)
    for (const field of doc.querySelectorAll('input,textarea,select'))
      vi.spyOn(field as HTMLInputElement, 'value', 'get').mockImplementation(() => {
        throw new Error('field read')
      })
    for (const el of doc.querySelectorAll('*')) {
      const get = el.getAttribute.bind(el)
      vi.spyOn(el, 'getAttribute').mockImplementation((name) => {
        if (['data-account', 'value', 'onclick', 'href', 'title'].includes(name))
          throw new Error('attribute read')
        return get(name)
      })
    }
    const result = readLotteHistoryLayout(doc)
    expect(result.representative?.map((node) => node.tag)).toEqual(['li', 'strong', 'span'])
    expect(JSON.stringify(result)).not.toMatch(/private|secret|merchant/)
  })
  it('returns only exact public more controls inside the list parent with a value-free relative path', () => {
    const doc = at(
      '<section><ul id="useCardList"><li>private</li></ul><div><button id="private-account-123"><span>더보기</span></button></div><a hidden>더보기</a><button>other-private</button></section><button>더보기</button>'
    )
    const result = readLotteHistoryLayout(doc)
    expect(result.moreControls).toHaveLength(1)
    expect(result.moreControls![0]).toMatchObject({
      path: [2, 1],
      node: { tag: 'button', hasUnlistedId: true, textKind: 'fixed_label', label: '더보기' }
    })
    expect(JSON.stringify(result)).not.toMatch(/private|123/)
    expect(lotteHistoryLayoutSchema.safeParse(result).success).toBe(true)
  })
  it.each([
    'http://www.lottecard.co.kr/app/LPMCDAA_V100.lc',
    'https://lottecard.co.kr/app/LPMCDAA_V100.lc',
    'https://www.lottecard.co.kr:8443/app/LPMCDAA_V100.lc',
    'https://www.lottecard.co.kr.evil.test/app/LPMCDAA_V100.lc',
    'https://user:pass@www.lottecard.co.kr/app/LPMCDAA_V100.lc',
    'https://www.lottecard.co.kr/app/LPMANAA_V200.lc'
  ])('refuses all other origins or routes before selecting any content: %s', (url) => {
    const doc = at('<ul id="useCardList"><li>private</li></ul>', url)
    const query = vi.spyOn(doc, 'querySelectorAll')
    expect(readLotteHistoryLayout(doc)).toEqual({ state: 'unsupported' })
    expect(query).not.toHaveBeenCalled()
  })
  it('refuses an embedded document and hidden or ambiguous roots', () => {
    const doc = at('<iframe></iframe>')
    expect(readLotteHistoryLayout(doc.querySelector('iframe')!.contentDocument!)).toEqual({
      state: 'unsupported'
    })
    expect(
      readLotteHistoryLayout(at('<ul id="useCardList" hidden><li>private</li></ul>')).state
    ).toBe('root_missing')
    expect(
      readLotteHistoryLayout(at('<ul id="useCardList"></ul><ul id="useCardList"></ul>')).state
    ).toBe('root_ambiguous')
  })
  it('caps node count and depth, does not replace first-row shape with a whole-page dump', () => {
    const many = readLotteHistoryLayout(
      at(`<ul id="useCardList"><li>${'<span>private</span>'.repeat(100)}</li><li>later</li></ul>`)
    )
    expect(many.representative).toHaveLength(80)
    expect(many.truncated).toBe(true)
    const deep = readLotteHistoryLayout(
      at(`<ul id="useCardList"><li>${'<div>'.repeat(12)}private${'</div>'.repeat(12)}</li></ul>`)
    )
    expect(Math.max(...deep.representative!.map((node) => node.depth))).toBe(6)
    expect(deep.truncated).toBe(true)
  })
  it('rejects accidental raw text, dynamic IDs/classes or extra response fields at the main boundary', () => {
    const good = readLotteHistoryLayout(
      at('<ul id="useCardList"><li><strong>private</strong></li></ul>')
    )
    for (const patch of [
      { text: 'private' },
      { id: 'approval-123456789' },
      { classes: ['secret-account'] },
      { label: 'private' }
    ]) {
      const altered = { ...good, representative: [{ ...good.representative![0], ...patch }] }
      expect(lotteHistoryLayoutSchema.safeParse(altered).success).toBe(false)
    }
    expect(lotteHistoryLayoutSchema.safeParse({ ...good, raw: 'private' }).success).toBe(false)
  })
})
