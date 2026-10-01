// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.hyundaicard.com/history?session=not-stored"}
import { beforeEach, describe, expect, it } from 'vitest'
import { captureFinanceTables, FINANCE_CAPTURE_LIMITS } from '../src/preload/page-finance'
import { runAgentOp } from '../src/preload/page-core'

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('finance fixed DOM capture', () => {
  it('preserves cell boundaries and raw text without interpreting money or status', () => {
    document.body.innerHTML =
      '<table><tr><th>승인번호</th><th>금액</th><th>상태</th></tr><tr><td>00123456</td><td>12,345 원</td><td>부분취소</td></tr></table>'
    const captured = captureFinanceTables()
    expect(captured.origin).toBe('https://www.hyundaicard.com')
    expect(captured.pathname).toBe('/history')
    expect(JSON.stringify(captured)).not.toContain('session')
    expect(captured.tables[0].rows[1].map((cell) => cell.text)).toEqual([
      '00123456',
      '12,345 원',
      '부분취소'
    ])
    expect(captured.tables[0].rows[0][0].header).toBe(true)
  })

  it('does not read hidden data, editable fields, script, or HTML attributes', () => {
    document.body.innerHTML =
      '<table><tr><td data-secret="attribute-secret">공개 <input value="input-secret"><textarea>textarea-secret</textarea><script>script-secret</script><span hidden>hidden-secret</span><span contenteditable>editable-secret</span></td></tr><tr hidden><td>hidden-row-secret</td></tr></table><table style="display:none"><tr><td>hidden-table-secret</td></tr></table>'
    const captured = captureFinanceTables()
    expect(captured.tables).toHaveLength(1)
    expect(captured.tables[0].rows[0][0].text).toBe('공개')
    expect(captured.tables[0].hiddenRows).toBe(1)
    expect(JSON.stringify(captured)).not.toContain('secret')
  })

  it('retains span evidence instead of inventing a flat accounting row', () => {
    document.body.innerHTML = '<table><tr><th rowspan="2" colspan="3">합계</th></tr></table>'
    expect(captureFinanceTables().tables[0].rows[0][0]).toEqual({
      text: '합계',
      header: true,
      rowSpan: 2,
      colSpan: 3
    })
  })

  it('rejects oversized captures instead of returning silently truncated rows', () => {
    document.body.innerHTML = `<table>${'<tr><td>1</td></tr>'.repeat(FINANCE_CAPTURE_LIMITS.rows + 1)}</table>`
    expect(() => captureFinanceTables()).toThrow('finance_capture_limit')
    document.body.innerHTML = `<table><tr><td>${'x'.repeat(FINANCE_CAPTURE_LIMITS.cellChars + 1)}</td></tr></table>`
    expect(() => captureFinanceTables()).toThrow('finance_capture_limit')
  })

  it('uses the DOM even when a caller attempts to supply fabricated rows', () => {
    document.body.innerHTML = '<table><tr><td>실제 DOM</td></tr></table>'
    const capture = runAgentOp({ op: 'financeTables', rows: [['fabricated amount']] })
    expect(JSON.stringify(capture)).toContain('실제 DOM')
    expect(JSON.stringify(capture)).not.toContain('fabricated')
  })

  it('rejects documents outside the approved origin', () => {
    expect(() => captureFinanceTables(document.implementation.createHTMLDocument())).toThrow(
      'finance_origin_not_allowed'
    )
  })
})
