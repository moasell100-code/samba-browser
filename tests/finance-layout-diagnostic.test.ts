// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.hyundaicard.com/cpa/cb/CPACB0101_01.hc"}
import { beforeEach, describe, expect, it } from 'vitest'
import { captureFinanceTables } from '../src/preload/page-finance'
import { financeFrameCaptureSchema } from '../src/main/finance/capture-schema'
import { FinanceCaptureStore } from '../src/main/finance/capture-store'
import type { FinanceFrameCapture, FinancePageCapture } from '../src/shared/finance-capture'

const path = '/cpa/cb/CPACB0101_01.hc'

beforeEach(() => {
  window.history.replaceState({}, '', path)
  document.body.innerHTML = ''
})

function emptyFrame(): FinanceFrameCapture {
  return { origin: 'https://www.hyundaicard.com', pathname: path, tables: [] }
}

function page(frame = captureFinanceTables()): FinancePageCapture {
  return { frames: [frame], failedFrames: 0, skippedFrames: 0 }
}

describe('scoped finance layout diagnostic', () => {
  it('returns only tags and classes, excluding financial text, identifiers, attributes and form subtrees', () => {
    document.body.innerHTML = `
      <div id="outside-secret" class="outside-secret">outside-secret</div>
      <div id="divHistoryUseRight" class="history-list" title="title-secret" data-account="account-secret">
        merchant-secret 9,876,543
        <ul class="rows"><li class="row current" id="approval-secret" aria-label="name-secret">
          <a class="detail" href="https://example.test/link-secret">merchant-secret</a>
          <span class="amount" data-value="amount-secret">9,876,543</span>
          <img class="icon" src="/image-secret" alt="alt-secret">
          <input class="input-secret" value="value-secret">
          <textarea class="textarea-secret">textarea-secret</textarea>
          <select class="select-secret"><option>option-secret</option></select>
          <button class="button-secret"><span>button-secret</span></button>
          <form class="form-secret"><div class="form-child-secret">form-secret</div></form>
          <script class="script-secret">script-secret</script>
          <style class="style-secret">.style-secret { color: red; }</style>
          <template class="template-secret"><span>template-secret</span></template>
          <span class="editable-secret" contenteditable><b>editable-secret</b></span>
          <span class="hidden-secret" hidden><b>hidden-secret</b></span>
          <span class="aria-secret" aria-hidden="true"><b>aria-secret</b></span>
          <span class="display-secret" style="display:none"><b>display-secret</b></span>
          <span class="visibility-secret" style="visibility:hidden"><b>visibility-secret</b></span>
          <custom-secret class="custom-secret"><span>custom-secret</span></custom-secret>
        </li></ul>
      </div>`
    const captured = captureFinanceTables()
    expect(captured.layoutDiagnostic).toEqual({
      nodes: [
        { depth: 0, tag: 'div', classes: ['history-list'] },
        { depth: 1, tag: 'ul', classes: ['rows'] },
        { depth: 2, tag: 'li', classes: ['row', 'current'] },
        { depth: 3, tag: 'a', classes: ['detail'] },
        { depth: 3, tag: 'span', classes: ['amount'] },
        { depth: 3, tag: 'img', classes: ['icon'] }
      ],
      truncated: false
    })
    const receipt = new FinanceCaptureStore().save(page(captured))
    expect(receipt.layoutDiagnostic).toEqual(captured.layoutDiagnostic)
    expect(receipt.issues).toContain('no_tables')
    expect(JSON.stringify(receipt)).not.toMatch(/secret|9,876,543|divHistoryUseRight/)
  })

  it.each(['/history', `${path}/`, '/cpa/cb/CPACB0101_02.hc', '/CPA/CB/CPACB0101_01.hc'])(
    'does not inspect a same-origin page outside the exact history route: %s',
    (otherPath) => {
      window.history.replaceState({}, '', otherPath)
      document.body.innerHTML = '<div id="divHistoryUseRight" class="outside-route-secret"></div>'
      expect(captureFinanceTables().layoutDiagnostic).toBeUndefined()
    }
  )

  it('excludes URL query values and does not return a diagnostic when a visible table exists', () => {
    window.history.replaceState({}, '', `${path}?account=query-secret`)
    document.body.innerHTML = '<div id="divHistoryUseRight" class="history-list"></div>'
    expect(captureFinanceTables().layoutDiagnostic).toBeDefined()
    expect(JSON.stringify(captureFinanceTables())).not.toContain('query-secret')
    document.body.insertAdjacentHTML('beforeend', '<table><tr><td>row</td></tr></table>')
    expect(captureFinanceTables().layoutDiagnostic).toBeUndefined()
  })

  it.each([
    '<div class="other-root"></div>',
    '<div hidden><div id="divHistoryUseRight"></div></div>',
    '<div style="display:none"><div id="divHistoryUseRight"></div></div>',
    '<form><div id="divHistoryUseRight"></div></form>',
    '<div contenteditable><div id="divHistoryUseRight"></div></div>'
  ])('omits missing, hidden, or editable roots', (html) => {
    document.body.innerHTML = html
    expect(captureFinanceTables().layoutDiagnostic).toBeUndefined()
  })

  it('limits structure to 80 nodes and depth 8 with an explicit truncation marker', () => {
    document.body.innerHTML = `<div id="divHistoryUseRight">${'<span class="row"></span>'.repeat(100)}</div>`
    let result = captureFinanceTables().layoutDiagnostic!
    expect(result.nodes).toHaveLength(80)
    expect(result.truncated).toBe(true)
    document.body.innerHTML = `<div id="divHistoryUseRight">${'<div>'.repeat(12)}${'</div>'.repeat(12)}</div>`
    result = captureFinanceTables().layoutDiagnostic!
    expect(result.nodes.map((node) => node.depth)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(result.truncated).toBe(true)
  })

  it('limits class tokens and excludes non-CSS identifiers or oversized tokens', () => {
    document.body.innerHTML = '<div id="divHistoryUseRight"></div>'
    const root = document.getElementById('divHistoryUseRight')!
    root.className = `123456 한글 ${'a'.repeat(65)} x@y ${Array.from({ length: 20 }, (_, i) => `row-${i}`).join(' ')}`
    const result = captureFinanceTables().layoutDiagnostic!
    expect(result.nodes[0].classes).toEqual(Array.from({ length: 12 }, (_, i) => `row-${i}`))
    expect(result.truncated).toBe(true)
  })
})

describe('layout diagnostic boundary', () => {
  const diagnostic = {
    nodes: [{ depth: 0, tag: 'div', classes: ['history-list'] }],
    truncated: false
  }

  it('rejects diagnostics on other routes and diagnostics with data-bearing properties', () => {
    const frame = { ...emptyFrame(), layoutDiagnostic: diagnostic }
    expect(financeFrameCaptureSchema.safeParse(frame).success).toBe(true)
    expect(financeFrameCaptureSchema.safeParse({ ...frame, pathname: '/history' }).success).toBe(
      false
    )
    for (const extra of ['text', 'id', 'value', 'html', 'attributes']) {
      expect(
        financeFrameCaptureSchema.safeParse({
          ...frame,
          layoutDiagnostic: {
            ...diagnostic,
            nodes: [{ ...diagnostic.nodes[0], [extra]: 'private-secret' }]
          }
        }).success
      ).toBe(false)
    }
  })

  it('rejects oversized or prohibited diagnostic nodes at the process boundary', () => {
    for (const bad of [
      { ...diagnostic, nodes: Array(81).fill(diagnostic.nodes[0]) },
      { ...diagnostic, nodes: [{ depth: 9, tag: 'div', classes: [] }] },
      { ...diagnostic, nodes: [{ depth: 0, tag: 'input', classes: [] }] },
      { ...diagnostic, nodes: [{ depth: 0, tag: 'script', classes: [] }] },
      { ...diagnostic, nodes: [{ depth: 0, tag: 'div', classes: ['value-secret@host'] }] }
    ]) {
      expect(
        financeFrameCaptureSchema.safeParse({ ...emptyFrame(), layoutDiagnostic: bad }).success
      ).toBe(false)
    }
  })

  it('returns diagnostics only from the main frame and only when no tables exist in any frame', () => {
    const store = new FinanceCaptureStore()
    const main = { ...emptyFrame(), layoutDiagnostic: diagnostic }
    expect(store.save({ ...page(), frames: [emptyFrame(), main] }).layoutDiagnostic).toBeUndefined()
    const tableFrame: FinanceFrameCapture = {
      ...emptyFrame(),
      tables: [{ index: 0, rows: [], hiddenRows: 0, hasNestedTable: false }]
    }
    const receipt = store.save({ ...page(), frames: [main, tableFrame] })
    expect(receipt.layoutDiagnostic).toBeUndefined()
    expect(receipt.issues).not.toContain('no_tables')
    expect(
      financeFrameCaptureSchema.safeParse({ ...tableFrame, layoutDiagnostic: diagnostic }).success
    ).toBe(false)
  })
})
