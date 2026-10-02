import { describe, it, expect } from 'vitest'
import { lotteResponseShapeIssues } from '../src/main/finance/lotte-api-diagnostics'
describe('Lotte structural facts', () => {
  it('classifies masked card notation without returning the card text or digits', () => {
    const flags = lotteResponseShapeIssues({
      Content:
        '<li class="toggle"><div class="info"><span>PRIVATE_DATE</span><span>PRIVATE_CARD(1*23)</span></div></li>'
    })
    expect(flags).toContain('shape_card_format_2')
    expect(JSON.stringify(flags)).not.toMatch(/PRIVATE|1\*23/)
  })
  it('never emits business text, payload values, unknown JSON keys, or attribute values', () => {
    const flags = lotteResponseShapeIssues({
      Content: `<li class="toggle"><strong>PRIVATE_MERCHANT</strong><button data-apruse='{"aprno":"PRIVATE_APPROVAL","cdno":"PRIVATE_CARD","PRIVATE_KEY":"SECRET"}' data-hidden="SECRET"><div class="useList"></div></button></li>`
    })
    expect(flags).toContain('shape_json_data_apruse')
    expect(flags).toContain('shape_key_aprno')
    expect(flags).toContain('shape_detail_empty')
    expect(JSON.stringify(flags)).not.toMatch(/PRIVATE|SECRET/)
  })
  it('reports a fixed public empty label only', () => {
    expect(
      lotteResponseShapeIssues({
        Content: '<div class="noData"><p>조회 내역이 없습니다.</p></div>'
      })
    ).toEqual(
      expect.arrayContaining([
        'shape_top_div',
        'shape_empty_label_1',
        'shape_empty_class_nodata',
        'shape_empty_node_div',
        'shape_empty_node_label_1',
        'shape_empty_node_p'
      ])
    )
    expect(lotteResponseShapeIssues({ Content: 'PRIVATE_EMPTY_MESSAGE' })).toEqual([])
    expect(lotteResponseShapeIssues({ Content: '  ' })).toEqual(['shape_empty_content'])
  })
})
