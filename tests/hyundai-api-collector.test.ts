import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../src/main/browser/tab-manager'
import { pageBridge } from '../src/main/browser/page-bridge'
import {
  collectHyundaiApi,
  inspectHyundaiAcquired,
  inspectHyundaiScope,
  parseHyundaiApiPage,
  requestHyundaiApiPage,
  type HyundaiApiForm
} from '../src/main/finance/hyundai-api-collector'

const HISTORY = 'https://www.hyundaicard.com/cpa/cb/CPACB0101_01.hc'
const QUERY = 'https://www.hyundaicard.com/cpa/cb/apiCPACB0101_21.hc'
const windows: JSDOM[] = []
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const dom of windows.splice(0)) dom.window.close()
})

function approval(overrides: Record<string, unknown> = {}): object {
  return {
    avUseItm: {
      avDt: '20261002',
      avDttm: '20261002121314',
      avHmsc: '121314',
      avNo: '00001234',
      avAmt: '12,500',
      cardNm: '합성 현대카드',
      cdno: '0000000000005432',
      crno: 'PRIVATE_CARD_REFERENCE',
      useMrchNm: '합성 상점',
      mrchNm: '합성 상점 원명',
      cancDttm: '',
      ...overrides
    }
  }
}

function payload(items: object[] = [approval()], day = '20261002', total = items.length): object {
  return {
    bdy: {
      rcntSummaryInfo: {
        totUseCnt: total,
        srtDt: day,
        endDt: day,
        crno: 'ALL_PRIVATE_CARDS',
        zoneClsf: 'ALL_PRIVATE_ZONE',
        useClsf: 'ALL_PRIVATE_USE',
        usplClsf: 'ALL_PRIVATE_MERCHANTS',
        dtClsf: 'PRIVATE_CUSTOM_PERIOD'
      },
      rcntAvItm: items,
      privateUnrelatedField: 'PRIVATE_UNRELATED_FIELD'
    }
  }
}

function form(): HyundaiApiForm {
  return {
    crno: 'ALL_PRIVATE_CARDS',
    dmfrClsf: 'PRIVATE_DMFR',
    dtClsf: 'PRIVATE_CUSTOM_PERIOD',
    endDt: '20261002',
    listClsf: 'PRIVATE_RECENT_APPROVAL',
    sortType: 'PRIVATE_SORT',
    srtDt: '20261002',
    useClsf: 'ALL_PRIVATE_USE',
    usplClsf: 'ALL_PRIVATE_MERCHANTS',
    zoneClsf: 'ALL_PRIVATE_ZONE'
  }
}

function fixture(): {
  tab: Tab
  dom: JSDOM
  fetch: ReturnType<typeof vi.fn>
  execute: ReturnType<typeof vi.fn>
  auth: ReturnType<typeof vi.spyOn<typeof pageBridge, 'hyundaiAuth'>>
  setUrl: (value: string) => void
} {
  let url = HISTORY
  const f = form()
  const dom = new JSDOM(
    `<form id="form1">
      <select name="crno"><option value="${f.crno}">전체</option><option selected value="SELECTED_PRIVATE_CARD">개별 카드</option></select>
      <input type="hidden" name="dmfrClsf" value="${f.dmfrClsf}">
      <input type="hidden" name="sortType" value="${f.sortType}">
      <input type="radio" name="dtClsf" id="dtClsf_04" value="${f.dtClsf}"><label for="dtClsf_04">직접 입력</label>
      <input type="radio" name="listClsf" id="listClsf_01" value="${f.listClsf}"><label for="listClsf_01">실시간 승인</label>
      <input type="hidden" id="iqrySrtDt" value="20260101"><input type="hidden" id="iqryEndDt" value="20260131">
      ${['useClsf', 'usplClsf', 'zoneClsf'].map((name) => `<input type="radio" name="${name}" id="${name}_all" value="${f[name as keyof HyundaiApiForm]}"><label for="${name}_all">전체</label>`).join('')}
      <input type="password" name="notARequestField" value="PASSWORD_PRIVATE_VALUE">
    </form>`,
    { url: HISTORY, runScripts: 'outside-only' }
  )
  windows.push(dom)
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const params = new URLSearchParams(String(init.body))
    const day = params.get('srtDt')!
    const compact = day.replaceAll('-', '')
    return new Response(
      JSON.stringify(payload([approval({ avDt: compact, avDttm: compact + '121314' })], day)),
      { headers: { 'Content-Type': 'application/json; charset=UTF-8' } }
    )
  })
  const execute = vi.fn(async (code: string, userGesture: boolean) => {
    expect(userGesture).toBe(false)
    return dom.window.eval(code)
  })
  const tab = {
    view: {
      webContents: {
        getURL: () => url,
        isDestroyed: () => false,
        session: { fetch },
        executeJavaScript: execute
      }
    }
  } as unknown as Tab
  const auth = vi.spyOn(pageBridge, 'hyundaiAuth').mockResolvedValue({ state: 'signed_in' })
  return { tab, dom, fetch, execute, auth, setUrl: (next) => (url = next) }
}

function cappedFixture(firstCount = 350, secondCount = 350): ReturnType<typeof fixture> {
  const f = fixture()
  f.dom.window.document.querySelector<HTMLInputElement>('[name="dmfrClsf"]')!.value = ''
  const select = f.dom.window.document.querySelector('select')!
  select.options[1].value = 'PRIVATE_CARD_REFERENCE'
  select.options[1].label = '합성 카드 (0000-00**-****-5432)'
  const second = f.dom.window.document.createElement('option')
  second.value = 'SECOND_PRIVATE_REFERENCE'
  second.label = '합성 카드 (0000-00**-****-1234)'
  select.append(second)
  const groups: Record<string, object[]> = {
    PRIVATE_CARD_REFERENCE: Array.from({ length: firstCount }, (_, i) =>
      approval({ avClsf: '0', avNo: String(i) })
    ),
    SECOND_PRIVATE_REFERENCE: Array.from({ length: secondCount }, (_, i) =>
      approval({
        avClsf: '0',
        avNo: String(i),
        crno: 'SECOND_PRIVATE_REFERENCE',
        cdno: '0000000000001234'
      })
    )
  }
  const all = Object.values(groups).flat()
  f.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
    const reference = new URLSearchParams(String(init.body)).get('crno')!
    const data = payload(
      reference === 'ALL_PRIVATE_CARDS' ? all.slice(0, 630) : groups[reference],
      '20261002',
      reference === 'ALL_PRIVATE_CARDS' ? all.length : groups[reference].length
    ) as { bdy: { rcntSummaryInfo: Record<string, unknown> } }
    data.bdy.rcntSummaryInfo.crno = reference
    return Response.json(data)
  })
  return f
}

describe('Hyundai private approval response normalization', () => {
  it('normalizes displayed won amounts without inventing approval or cancellation certainty', () => {
    const result = parseHyundaiApiPage(payload())
    expect(result.rowCount).toBe(1)
    expect(result.reportedTotal).toBe(1)
    expect(result.rows[0]).toMatchObject({
      issuer: 'hyundai_card',
      approvedAt: '2026-10-02T12:13:14+09:00',
      approvalNumber: '00001234',
      cardLast4: '5432',
      cardLabel: '합성 현대카드',
      merchant: '합성 상점',
      amount: 12500,
      status: 'unknown',
      kind: 'status',
      netAmount: null,
      cancellationAmount: null
    })
    expect(result.rows[0].sourceId).toMatch(/^hyundai_card:[a-f0-9]{64}$/)
    expect(result.rows[0].needsReview).toContain('approval_status_unverified')
    expect(result.rows[0].needsReview).not.toContain('currency_unverified')
    for (const value of ['PRIVATE_CARD_REFERENCE', '0000000000005432', 'PRIVATE_UNRELATED_FIELD'])
      expect(JSON.stringify(result)).not.toContain(value)
  })

  it('flags loans and cancellation observations while leaving actual refund/net amounts unset', () => {
    const result = parseHyundaiApiPage(
      payload([approval({ useClsf: '5', avClsf: '1', cancDttm: '20261002141516', avAmt: -12500 })])
    )
    expect(result.rows[0].needsReview).toEqual(
      expect.arrayContaining(['loan_not_expense', 'cancellation_amount_unverified'])
    )
    expect(result.rows[0].eventDate).toBe('2026-10-02')
    expect(result.rows[0].cancellationAmount).toBeNull()
    expect(result.rows[0].netAmount).toBeNull()
  })

  it.each(['0', '2'])(
    'recognizes verified non-cancellation code %s and the renderer displayed won amount',
    (code) => {
      const result = parseHyundaiApiPage(payload([approval({ avClsf: code, acplCrncCd: '410' })]))
      expect(result.rows[0]).toMatchObject({
        kind: 'approval',
        status: 'approved',
        amount: 12500,
        netAmount: 12500,
        needsReview: []
      })
      const noCurrency = parseHyundaiApiPage(payload([approval({ avClsf: code })]))
      expect(noCurrency.rows[0].netAmount).toBe(12500)
      expect(noCurrency.rows[0].needsReview).toEqual([])
    }
  )

  it('does not use foreign, loan, negative or unknown-status amounts as verified expenses', () => {
    const variants = [
      { avClsf: '0', acplCrncCd: '840' },
      { avClsf: '0', acplCrncCd: 'KRW', useClsf: '7' },
      { avClsf: '2', acplCrncCd: 'KRW', avAmt: -500 },
      { avClsf: 'UNRECOGNIZED', acplCrncCd: 'KRW' }
    ]
    for (const variant of variants) {
      const result = parseHyundaiApiPage(payload([approval(variant)]))
      expect(result.rows[0].netAmount).toBeNull()
      expect(result.rows[0].needsReview.length).toBeGreaterThan(0)
    }
  })

  it.each(['1', '3'])(
    'keeps cancellation code %s distinct from its original approval without inventing a refund',
    (code) => {
      const original = approval({ avClsf: '0', acplCrncCd: 'KRW' })
      const cancellation = approval({ avClsf: code, acplCrncCd: 'KRW', cancDttm: '20261002141516' })
      const result = parseHyundaiApiPage(payload([original, cancellation]))
      expect(result.rows[1]).toMatchObject({
        kind: 'cancellation',
        status: 'cancelled',
        eventDate: '2026-10-02',
        netAmount: null,
        cancellationAmount: null,
        cancellationEvidence: false
      })
      expect(result.rows[1].sourceId).not.toBe(result.rows[0].sourceId)
      expect(result.rows[1].needsReview).toContain('cancellation_amount_unverified')
    }
  )

  it('does not drop unknown transportation rows or truncated results silently', () => {
    const result = parseHyundaiApiPage(
      payload([approval(), { trfcUseItm: {} }, { hipsUseItm: {} }], '20261002', 4)
    )
    expect(result.rowCount).toBe(3)
    expect(result.rows).toHaveLength(1)
    expect(result.issues).toEqual(
      expect.arrayContaining(['unrecognized_rows', 'total_count_mismatch'])
    )
    expect(parseHyundaiApiPage({ bdy: { rcntAvItm: [] } }).issues).toContain(
      'total_count_unverified'
    )
    expect(parseHyundaiApiPage(payload([]))).toMatchObject({
      rows: [],
      issues: [],
      rowCount: 0,
      reportedTotal: 0
    })
  })

  it('rejects malformed rows and business errors without reading accessor properties', () => {
    expect(
      parseHyundaiApiPage(payload([approval({ avDt: '20260230', avDttm: 'invalid' })])).issues
    ).toContain('invalid_transaction_row')
    expect(parseHyundaiApiPage(payload([approval({ avAmt: '12,50' })])).issues).toContain(
      'invalid_transaction_row'
    )
    const getter = vi.fn(() => {
      throw new Error('PRIVATE_GETTER')
    })
    const body = {}
    Object.defineProperty(body, 'rcntAvItm', { get: getter })
    expect(parseHyundaiApiPage({ bdy: body }).rowCount).toBeNull()
    expect(getter).not.toHaveBeenCalled()
    expect(
      parseHyundaiApiPage({
        bdy: { rcntAvItm: [], error_code: 'E', error_message: 'PRIVATE_MESSAGE' }
      }).issues
    ).toEqual(['service_error'])
  })

  it('uses stable hashed identities and marks both ambiguous duplicates', () => {
    const initial = parseHyundaiApiPage(payload())
    const changed = parseHyundaiApiPage(
      payload([approval({ avAmt: 9999, useMrchNm: '변경 상점' })])
    )
    expect(initial.rows[0].sourceId).toBe(changed.rows[0].sourceId)
    const duplicate = parseHyundaiApiPage(payload([approval(), approval()]))
    expect(duplicate.issues).toContain('duplicate_source_identity')
    expect(
      duplicate.rows.every((row) => row.needsReview.includes('duplicate_source_identity'))
    ).toBe(true)
  })

  it('matches a private card reference without changing identity or leaking the reference', () => {
    const response = payload([approval({ avClsf: '0', cdno: 'UNAVAILABLE_FORMAT' })])
    const before = parseHyundaiApiPage(response)
    const after = parseHyundaiApiPage(response, [
      { crno: 'PRIVATE_CARD_REFERENCE', status: 'matched', last4: '5432' }
    ])
    expect(after.rows[0].sourceId).toBe(before.rows[0].sourceId)
    expect(after.rows[0]).toMatchObject({ cardLast4: '5432', needsReview: [] })
    expect(JSON.stringify(after)).not.toContain('PRIVATE_CARD_REFERENCE')
    const unrelated = parseHyundaiApiPage(response, [
      { crno: 'OTHER_PRIVATE_REFERENCE', status: 'matched', last4: '5432' }
    ])
    expect(unrelated.rows[0].cardLast4).toBeUndefined()
    expect(unrelated.rows[0].needsReview).toContain('card_last4_unavailable')
  })

  it('keeps duplicate mappings and conflicting card tails in review', () => {
    const response = payload([approval({ avClsf: '0' })])
    const conflict = parseHyundaiApiPage(response, [
      { crno: 'PRIVATE_CARD_REFERENCE', status: 'matched', last4: '1234' }
    ])
    expect(conflict.rows[0].cardLast4).toBeUndefined()
    expect(conflict.rows[0].needsReview).toContain('card_last4_conflict')
    const duplicate = parseHyundaiApiPage(response, [
      { crno: 'PRIVATE_CARD_REFERENCE', status: 'matched', last4: '5432' },
      { crno: 'PRIVATE_CARD_REFERENCE', status: 'matched', last4: '5432' }
    ])
    expect(duplicate.rows[0].needsReview).toContain('card_mapping_ambiguous')
  })

  it.each([
    ['000000**********', ['card_cdno_length_16', 'card_cdno_ascii', 'card_cdno_tail_masked']],
    ['000000●●●●●●●●●●', ['card_cdno_length_16', 'card_cdno_non_ascii', 'card_cdno_tail_masked']],
    ['UNKNOWN', ['card_cdno_length_other', 'card_cdno_ascii', 'card_cdno_tail_other']]
  ])('reports only fixed shape flags for an unavailable tail', (cdno, expected) => {
    const result = parseHyundaiApiPage(payload([approval({ cdno })]))
    expect(result.issues).toEqual(expect.arrayContaining(expected as string[]))
    expect(result.issues).toContain('card_reference_option_unmatched')
    expect(JSON.stringify(result.issues)).not.toContain(cdno as string)
    expect(JSON.stringify(result.issues)).not.toContain('PRIVATE_CARD_REFERENCE')
  })

  it.each([
    ['000000******123', '*123'],
    ['0000-00**-****-*123', '*123'],
    ['0000 00XX XXXX X12X', '*12*'],
    ['0000-00●●-●●●●-●●12', '**12']
  ])(
    'preserves an observed partial suffix from %s without reconstructing any digit',
    (cdno, suffix) => {
      const result = parseHyundaiApiPage(payload([approval({ avClsf: '0', cdno })]))
      expect(result.rows[0]).toMatchObject({ cardLast4: suffix, needsReview: [] })
      expect(result.rows[0].cardKey).toMatch(/^[a-f0-9]{64}$/)
      expect(result.issues).toContain('card_tail_partially_masked')
      expect(JSON.stringify(result)).not.toContain(cdno)
    }
  )

  it('keeps card keys stable across display-mask changes and distinct across actual card references', () => {
    const first = parseHyundaiApiPage(
      payload([approval({ avClsf: '0', cdno: '0000-00**-****-12**' })])
    ).rows[0]
    const clearer = parseHyundaiApiPage(
      payload([approval({ avClsf: '0', cdno: '0000-00**-****-1234' })])
    ).rows[0]
    const other = parseHyundaiApiPage(
      payload([approval({ avClsf: '0', crno: 'OTHER_CARD', cdno: '0000-00**-****-12**' })])
    ).rows[0]
    expect(first.cardKey).toBe(clearer.cardKey)
    expect(first.cardKey).not.toBe(other.cardKey)
    expect(first.sourceId).toBe(clearer.sourceId)
    const withoutReference = parseHyundaiApiPage(
      payload([approval({ avClsf: '0', crno: '', cdno: '0000-00xx-xxxx-12xx' })])
    ).rows[0]
    const sameNormalized = parseHyundaiApiPage(
      payload([approval({ avClsf: '0', crno: '', cdno: '000000******12**' })])
    ).rows[0]
    expect(withoutReference.cardKey).toBe(sameNormalized.cardKey)
    expect(withoutReference.cardKey).toMatch(/^[a-f0-9]{64}$/)
  })

  it('does not combine partial digits from independent masks or accept malformed card strings', () => {
    const response = payload([approval({ avClsf: '0', cdno: '0000-00**-****-12**' })])
    const compatible = parseHyundaiApiPage(response, [
      { crno: 'PRIVATE_CARD_REFERENCE', status: 'matched', last4: '**34' }
    ])
    expect(compatible.rows[0].cardLast4).toBe('12**')
    const conflicting = parseHyundaiApiPage(response, [
      { crno: 'PRIVATE_CARD_REFERENCE', status: 'matched', last4: '*334' }
    ])
    expect(conflicting.rows[0].cardLast4).toBeUndefined()
    expect(conflicting.rows[0].needsReview).toContain('card_last4_conflict')
    const malformed = parseHyundaiApiPage(payload([approval({ cdno: 'UNVERIFIED1234', crno: '' })]))
    expect(malformed.rows[0].cardLast4).toBeUndefined()
    expect(malformed.rows[0].cardKey).toBeUndefined()
  })

  it('distinguishes missing references from missing option patterns without promoting diagnostics to review reasons', () => {
    const missing = parseHyundaiApiPage(payload([approval({ crno: '', cdno: '' })]))
    expect(missing.issues).toEqual(
      expect.arrayContaining(['card_reference_missing', 'card_cdno_missing'])
    )
    const matched = parseHyundaiApiPage(payload([approval({ avClsf: '0', cdno: '' })]), [
      {
        crno: 'PRIVATE_CARD_REFERENCE',
        status: 'matched',
        last4: '5432',
        diagnostic: 'token_matched'
      }
    ])
    expect(matched.issues).toContain('card_option_token_matched')
    expect(matched.rows[0].needsReview).toEqual([])
  })

  it('marks the observed 630-real-row limit without treating 700 unknown slots as proven approvals', () => {
    const capped = parseHyundaiApiPage(
      payload(Array.from({ length: 630 }, (_, i) => approval({ avNo: String(i) })))
    )
    expect(capped.issues).toContain('daily_row_limit_possible')
    const unknown = parseHyundaiApiPage(payload(Array.from({ length: 700 }, () => ({}))))
    expect(unknown.rows).toHaveLength(0)
    expect(unknown.issues).toContain('unrecognized_rows')
  })
})

describe('Hyundai fixed authenticated read-only request and daily collector', () => {
  it.each(['form', 'card_selector'] as const)(
    'waits only for initial %s readiness before making one HTTP query',
    async (kind) => {
      vi.useFakeTimers()
      const f = fixture()
      const element = f.dom.window.document.querySelector(kind === 'form' ? 'form' : 'select')!
      const parent = element.parentNode!
      const next = element.nextSibling
      element.remove()
      const pending = collectHyundaiApi(f.tab, { from: '2026-10-02', to: '2026-10-02' })
      await vi.advanceTimersByTimeAsync(749)
      expect(f.fetch).not.toHaveBeenCalled()
      parent.insertBefore(element, next)
      await vi.advanceTimersByTimeAsync(1)
      const result = await pending
      expect(result.receipt.pages).toBe(1)
      expect(result.rows).toHaveLength(1)
      expect(f.fetch).toHaveBeenCalledOnce()
      expect(f.execute).toHaveBeenCalledTimes(4)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['request_schema_unverified', 'card_selector_unverified'])(
    'retains %s after the exact bounded DOM-only readiness window',
    async (issue) => {
      vi.useFakeTimers()
      const f = fixture()
      f.execute.mockResolvedValue({ ok: false, issue })
      const pending = collectHyundaiApi(f.tab, { from: '2026-10-02', to: '2026-10-02' })
      await vi.advanceTimersByTimeAsync(10_000)
      expect((await pending).receipt).toMatchObject({
        pages: 0,
        issues: [issue],
        elapsedMs: 10_000
      })
      expect(f.execute).toHaveBeenCalledTimes(40)
      expect(f.fetch).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('does not wait for a different history page or malformed success schema', async () => {
    vi.useFakeTimers()
    for (const plan of [
      { ok: false, issue: 'history_page_required' },
      { ok: true, data: null }
    ]) {
      const f = fixture()
      f.execute.mockResolvedValue(plan)
      const result = await collectHyundaiApi(f.tab, { from: '2026-10-02', to: '2026-10-02' })
      expect(result.receipt.elapsedMs).toBe(0)
      expect(f.execute).toHaveBeenCalledOnce()
      expect(f.fetch).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  })

  it.each(['navigation', 'tab', 'cancelled'] as const)(
    'stops initial DOM waiting on %s without any HTTP request',
    async (kind) => {
      vi.useFakeTimers()
      const f = fixture()
      const controller = new AbortController()
      f.execute.mockResolvedValue({ ok: false, issue: 'request_schema_unverified' })
      const pending = collectHyundaiApi(
        f.tab,
        { from: '2026-10-02', to: '2026-10-02' },
        { signal: controller.signal }
      )
      await vi.advanceTimersByTimeAsync(100)
      if (kind === 'navigation') f.setUrl('https://www.hyundaicard.com/cpm/mb/CPMMB0101_01.hc')
      if (kind === 'tab')
        Object.defineProperty(f.tab.view, 'webContents', { value: { ...f.tab.view.webContents } })
      if (kind === 'cancelled') controller.abort()
      await vi.advanceTimersByTimeAsync(150)
      expect((await pending).receipt.issues).toEqual([
        kind === 'cancelled' ? 'cancelled' : 'hyundai_navigation_changed'
      ])
      expect(f.execute).toHaveBeenCalledOnce()
      expect(f.fetch).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('bounds a stalled DOM read within the same initial deadline and preserves the last known issue', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.execute
      .mockResolvedValueOnce({ ok: false, issue: 'card_selector_unverified' })
      .mockImplementation(() => new Promise(() => {}))
    const pending = collectHyundaiApi(f.tab, { from: '2026-10-02', to: '2026-10-02' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await pending).receipt).toMatchObject({
      pages: 0,
      issues: ['card_selector_unverified'],
      elapsedMs: 10_000
    })
    expect(f.execute).toHaveBeenCalledTimes(2)
    expect(f.fetch).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not retry a changed schema after an earlier successful daily query', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const execute = f.execute.getMockImplementation()!
    f.execute
      .mockImplementationOnce(execute)
      .mockResolvedValue({ ok: false, issue: 'request_schema_unverified' })
    const result = await collectHyundaiApi(f.tab, { from: '2026-10-01', to: '2026-10-02' })
    expect(result.receipt.pages).toBe(1)
    expect(result.receipt.issues).toContain('request_schema_unverified')
    expect(result.receipt.elapsedMs).toBe(0)
    expect(f.fetch).toHaveBeenCalledOnce()
    expect(f.execute).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('recovers a capped day only after individual card echoes, totals and original snapshot all agree', async () => {
    const f = cappedFixture()
    const before = f.dom.window.document.querySelector('form')!.outerHTML
    const result = await collectHyundaiApi(f.tab, { from: '2026-10-02', to: '2026-10-02' })
    expect(result.receipt).toMatchObject({
      pages: 3,
      rowCount: 700,
      approvalComplete: true,
      complete: false
    })
    expect(result.receipt.issues).toContain('card_split_verified')
    expect(result.receipt.issues).not.toContain('daily_row_limit_possible')
    expect(result.rows.every((row) => row.needsReview.length === 0)).toBe(true)
    expect(f.dom.window.document.querySelector('form')!.outerHTML).toBe(before)
    expect(JSON.stringify(result.receipt)).not.toContain('SECOND_PRIVATE_REFERENCE')
  })

  it('keeps individual cards at the cap incomplete instead of inventing another page', async () => {
    const f = cappedFixture(630, 70)
    const result = await collectHyundaiApi(f.tab, { from: '2026-10-02', to: '2026-10-02' })
    expect(result.receipt).toMatchObject({ pages: 3, approvalComplete: false })
    expect(result.receipt.issues).toContain('card_split_incomplete')
    expect(result.receipt.issues).toContain('daily_row_limit_possible')
  })

  it('honors the request budget even when a split is needed', async () => {
    const f = cappedFixture()
    const result = await collectHyundaiApi(
      f.tab,
      { from: '2026-10-02', to: '2026-10-02' },
      { maxPages: 2 }
    )
    expect(f.fetch).toHaveBeenCalledTimes(2)
    expect(result.receipt.approvalComplete).toBe(false)
    expect(result.receipt.issues).toContain('page_limit')
  })

  it.each(['missing_card', 'row_reference', 'duplicate', 'changed_snapshot'])(
    'does not recover approval coverage when split validation finds %s',
    async (variant) => {
      const f = cappedFixture()
      if (variant === 'missing_card')
        f.dom.window.document.querySelector('select')!.lastElementChild!.remove()
      const original = f.fetch.getMockImplementation()!
      f.fetch.mockImplementation(async (url: string, init: RequestInit) => {
        const response = await original(url, init)
        const data = await response.json()
        const reference = new URLSearchParams(String(init.body)).get('crno')
        if (reference === 'PRIVATE_CARD_REFERENCE') {
          if (variant === 'row_reference')
            data.bdy.rcntAvItm[0].avUseItm.crno = 'OTHER_PRIVATE_REFERENCE'
          if (variant === 'duplicate') data.bdy.rcntAvItm[1] = data.bdy.rcntAvItm[0]
          if (variant === 'changed_snapshot') data.bdy.rcntAvItm[0].avUseItm.avAmt = 9999
        }
        return Response.json(data)
      })
      const result = await collectHyundaiApi(f.tab, { from: '2026-10-02', to: '2026-10-02' })
      expect(result.receipt.approvalComplete).toBe(false)
      expect(result.receipt.issues).toContain('card_split_incomplete')
      expect(result.receipt.issues).not.toContain('card_split_verified')
      if (variant === 'changed_snapshot')
        expect(result.rows[0].needsReview).toContain('source_identity_conflict')
    }
  )

  it('rejects a changed card-filter echo during a split before trusting any split rows', async () => {
    const f = cappedFixture()
    const original = f.fetch.getMockImplementation()!
    f.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      const response = await original(url, init)
      const data = await response.json()
      if (new URLSearchParams(String(init.body)).get('crno') === 'PRIVATE_CARD_REFERENCE')
        data.bdy.rcntSummaryInfo.crno = 'ALL_PRIVATE_CARDS'
      return Response.json(data)
    })
    const result = await collectHyundaiApi(f.tab, { from: '2026-10-02', to: '2026-10-02' })
    expect(result.receipt.approvalComplete).toBe(false)
    expect(result.receipt.issues).toContain('response_scope_unverified')
    expect(result.rows).toHaveLength(630)
    expect(result.rows.every((row) => row.needsReview.includes('card_split_incomplete'))).toBe(true)
  })

  it('preserves validated observations in review when a later split request fails', async () => {
    const f = cappedFixture()
    const original = f.fetch.getMockImplementation()!
    f.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (new URLSearchParams(String(init.body)).get('crno') === 'SECOND_PRIVATE_REFERENCE')
        throw new Error('PRIVATE_NETWORK_ERROR')
      return original(url, init)
    })
    const result = await collectHyundaiApi(f.tab, { from: '2026-10-02', to: '2026-10-02' })
    expect(result.receipt).toMatchObject({ pages: 3, rowCount: 630, approvalComplete: false })
    expect(result.receipt.issues).toContain('hyundai_request_unavailable')
    expect(result.rows.every((row) => row.needsReview.includes('card_split_incomplete'))).toBe(true)
    expect(JSON.stringify(result.receipt)).not.toContain('PRIVATE_NETWORK_ERROR')
  })

  it.each([false, true])(
    'preserves a cancellation returned by either day and handles duplicate field conflict=%s',
    async (conflict) => {
      const f = fixture()
      f.dom.window.document.querySelector<HTMLInputElement>('[name="dmfrClsf"]')!.value = ''
      f.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
        const day = new URLSearchParams(String(init.body)).get('srtDt')!
        return Response.json(
          payload(
            [
              approval({
                avClsf: '1',
                avDt: '20261001',
                avDttm: '20261001121314',
                cancDttm: '20261002141516',
                avAmt: conflict && day === '20261002' ? 9999 : 12500
              })
            ],
            day
          )
        )
      })
      const result = await collectHyundaiApi(f.tab, { from: '2026-10-01', to: '2026-10-02' })
      expect(result.rows).toHaveLength(1)
      expect(result.receipt.rowCount).toBe(1)
      expect(result.receipt.issues).not.toContain('approval_outside_requested_range')
      expect(result.rows[0].needsReview).toContain('cancellation_query_basis_unverified')
      expect(result.rows[0].cancellationAmount).toBeNull()
      if (conflict) {
        expect(result.rows[0].needsReview).toContain('source_identity_conflict')
        expect(result.receipt.approvalComplete).toBe(false)
      } else expect(result.rows[0].needsReview).not.toContain('source_identity_conflict')
    }
  )

  it.each([
    ['합성 카드 [1234]', 'card_option_token_missing'],
    ['합성 카드 0000-00**-****-****', 'card_option_token_tail_masked'],
    ['합성 카드 0000-00**-****-*123', 'card_option_token_tail_partially_masked'],
    ['합성 카드 0000-00**-****-**12', 'card_option_token_tail_partially_masked']
  ])(
    'identifies a matched reference but unresolved option format with %s',
    async (label, issue) => {
      const f = fixture()
      const option = f.dom.window.document.querySelectorAll('option')[1]
      option.value = 'PRIVATE_CARD_REFERENCE'
      option.label = label
      f.fetch.mockResolvedValue(
        Response.json(payload([approval({ avClsf: '0', cdno: 'UNKNOWN_NUMBER' })]))
      )
      const result = await collectHyundaiApi(f.tab, { from: '2026-10-02', to: '2026-10-02' })
      expect(result.receipt.issues).toEqual(
        expect.arrayContaining(['card_reference_option_matched', issue])
      )
      expect(result.rows[0].needsReview).not.toContain(issue)
      expect(JSON.stringify(result.receipt)).not.toContain(label)
      expect(JSON.stringify(result.receipt)).not.toContain('PRIVATE_CARD_REFERENCE')
      expect(JSON.stringify(result.receipt)).not.toContain('UNKNOWN_NUMBER')
    }
  )

  it.each([
    '(본인) 합성 카드 [0000-00**-****-5432]',
    '합성 카드 (000000*****5432)',
    '합성 카드 (0000 00XX XXXX 5432)',
    '합성 카드 (0000-00●●-●●●●-5432)',
    '합성 카드 (0000-00••-••••-5432)'
  ])('privately maps the single masked card token in %s to its exact reference', async (label) => {
    const f = fixture()
    const option = f.dom.window.document.querySelectorAll('option')[1]
    option.value = 'PRIVATE_CARD_REFERENCE'
    option.label = label
    f.fetch.mockResolvedValue(
      Response.json(payload([approval({ avClsf: '0', cdno: 'UNAVAILABLE_FORMAT' })]))
    )
    const before = f.dom.window.document.querySelector('form')!.outerHTML
    const result = await collectHyundaiApi(f.tab, { from: '2026-10-02', to: '2026-10-02' })
    expect(result.rows[0]).toMatchObject({ cardLast4: '5432', needsReview: [] })
    expect(f.dom.window.document.querySelector('form')!.outerHTML).toBe(before)
    expect(JSON.stringify(result.receipt)).not.toContain(label)
    expect(JSON.stringify(result.receipt)).not.toContain('PRIVATE_CARD_REFERENCE')
    expect(JSON.stringify(result.receipt)).not.toContain('5432')
  })

  it.each([
    '카드 (0000-00**-****-5432) (0000-00**-****-5432)',
    '카드 0000-00**-****-5432 0000-00**-****-1234'
  ])('does not choose one of multiple card tokens in %s', async (label) => {
    const f = fixture()
    const option = f.dom.window.document.querySelectorAll('option')[1]
    option.value = 'PRIVATE_CARD_REFERENCE'
    option.label = label
    f.fetch.mockResolvedValue(Response.json(payload([approval({ avClsf: '0', cdno: '' })])))
    const result = await collectHyundaiApi(f.tab, { from: '2026-10-02', to: '2026-10-02' })
    expect(result.rows[0].cardLast4).toBeUndefined()
    expect(result.rows[0].needsReview).toContain('card_mapping_ambiguous')
  })

  it('does not resolve a duplicate option reference, masked tail, or malformed card token', async () => {
    const f = fixture()
    const option = f.dom.window.document.querySelectorAll('option')[1]
    option.value = 'PRIVATE_CARD_REFERENCE'
    option.label = '합성 카드 0000-00**-****-5432'
    const duplicate = option.cloneNode(true) as HTMLOptionElement
    option.parentElement!.appendChild(duplicate)
    f.fetch.mockImplementation(async () =>
      Response.json(payload([approval({ avClsf: '0', cdno: '' })]))
    )
    const result = await collectHyundaiApi(f.tab, { from: '2026-10-02', to: '2026-10-02' })
    expect(result.rows[0].needsReview).toContain('card_mapping_ambiguous')
    expect(result.rows[0].cardLast4).toBeUndefined()
    duplicate.remove()
    for (const label of [
      '합성 카드 0000-00**-****-****',
      '합성 카드 [1234]',
      '합성 카드 0000-00**-****-54321'
    ]) {
      option.label = label
      const malformed = await collectHyundaiApi(f.tab, { from: '2026-10-02', to: '2026-10-02' })
      expect(malformed.rows[0].cardLast4).toBeUndefined()
      expect(malformed.rows[0].needsReview).toContain('card_last4_unavailable')
    }
  })

  it('proves approval coverage when whole scope and empty region agree with response dates and counts', async () => {
    const f = fixture()
    f.dom.window.document.querySelector<HTMLInputElement>('[name="dmfrClsf"]')!.value = ''
    const result = await collectHyundaiApi(f.tab, { from: '2026-09-29', to: '2026-10-02' })
    expect(result.receipt).toMatchObject({
      pages: 4,
      rowCount: 4,
      complete: false,
      approvalComplete: true,
      cancellationComplete: false
    })
    expect(result.receipt.issues).not.toContain('scope_unverified')
    expect(result.receipt.issues).toContain('cancellation_query_basis_unverified')
    // Unknown per-row status is quarantined separately from verified query coverage.
    expect(result.rows.every((row) => row.needsReview.includes('approval_status_unverified'))).toBe(
      true
    )
  })

  it.each([
    { items: [approval()], total: 2, issue: 'total_count_mismatch' },
    { items: [approval(), { trfcUseItm: {} }], total: 2, issue: 'unrecognized_rows' },
    {
      items: [approval({ avDt: '20261001', avDttm: '20261001121314' })],
      total: 1,
      issue: 'approval_outside_requested_range'
    },
    {
      items: Array.from({ length: 630 }, (_, i) => approval({ avNo: String(i) })),
      total: 630,
      issue: 'daily_row_limit_possible'
    }
  ])('does not claim complete approval coverage when $issue', async ({ items, total, issue }) => {
    const f = fixture()
    f.dom.window.document.querySelector<HTMLInputElement>('[name="dmfrClsf"]')!.value = ''
    f.fetch.mockResolvedValue(Response.json(payload(items, '20261002', total)))
    const result = await collectHyundaiApi(
      f.tab,
      { from: '2026-10-02', to: '2026-10-02' },
      { maxPages: 1 }
    )
    expect(result.receipt.approvalComplete).toBe(false)
    expect(result.receipt.issues).toContain(issue)
  })

  it.each([
    '전체',
    '전체 카드',
    '카드 전체',
    '모든 카드',
    '전체 보기',
    '전체 카드 보기',
    '카드 전체 보기',
    '전체 카드 조회',
    '전체 조회',
    '카드 전체 조회',
    '보유 카드 전체',
    '전체 카드 선택',
    '카드 전체 선택'
  ])('accepts the verified all-card option label %s without exposing its value', async (label) => {
    const f = fixture()
    f.dom.window.document.querySelector('select option')!.textContent = label
    const result = await collectHyundaiApi(f.tab, { from: '2026-10-02', to: '2026-10-02' })
    expect(f.fetch).toHaveBeenCalledOnce()
    expect(result.rows).toHaveLength(1)
    expect(result.receipt.approvalComplete).toBe(false)
  })

  it('projects only known scope labels, counts and format enums, never form values or custom card names', async () => {
    const f = fixture()
    f.dom.window.document.querySelector('select option')!.textContent = '전체 카드'
    f.dom.window.document.querySelector('select option:nth-child(2)')!.textContent =
      'PRIVATE_CARD_NAME'
    const inspected = await inspectHyundaiScope(f.tab)
    expect(inspected).toMatchObject({
      state: 'ready',
      formCount: 1,
      cardSelectCount: 1,
      cardDisabled: false,
      optionCount: 2,
      options: [
        { label: '전체카드', disabled: false },
        { label: 'unrecognized', disabled: false }
      ],
      directPresent: true,
      directLabels: ['직접입력'],
      recentPresent: true,
      regionFilterEmpty: false,
      allRadioCounts: { useClsf: 1, usplClsf: 1, zoneClsf: 1 },
      dateFormats: { start: 'compact', end: 'compact' }
    })
    for (const secret of [
      'PRIVATE_CARD_NAME',
      'ALL_PRIVATE_CARDS',
      'PASSWORD_PRIVATE_VALUE',
      '20260101'
    ])
      expect(JSON.stringify(inspected)).not.toContain(secret)
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('reports only whether the fixed hidden regional control is exactly empty', async () => {
    const f = fixture()
    const region = f.dom.window.document.querySelector<HTMLInputElement>('input[name="dmfrClsf"]')!
    region.value = ''
    expect(await inspectHyundaiScope(f.tab)).toMatchObject({ regionFilterEmpty: true })
    region.value = 'PRIVATE_REGIONAL_VALUE'
    const snapshot = await inspectHyundaiScope(f.tab)
    expect(snapshot).toMatchObject({ regionFilterEmpty: false })
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_REGIONAL_VALUE')
  })

  it('retains a recent cancellation of an older approval using the renderer cancellation date', async () => {
    const f = fixture()
    f.fetch.mockResolvedValue(
      Response.json(
        payload([
          approval({
            avClsf: '1',
            avDt: '20260904',
            avDttm: '20260904121314',
            cancDttm: '20261002091011',
            acplCrncCd: 'KRW'
          })
        ])
      )
    )
    const result = await collectHyundaiApi(f.tab, { from: '2026-10-02', to: '2026-10-02' })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].approvedAt).toBe('2026-09-04T12:13:14+09:00')
    expect(result.rows[0].eventDate).toBe('2026-10-02')
    expect(result.receipt.issues).not.toContain('approval_outside_requested_range')
  })

  it('uses a native option label attribute with an empty text node without exposing private labels', async () => {
    const f = fixture()
    const options = f.dom.window.document.querySelectorAll('option')
    options[0].textContent = ''
    options[0].setAttribute('label', '전체')
    options[1].textContent = ''
    options[1].setAttribute('label', 'PRIVATE_CARD_LABEL')
    const inspected = await inspectHyundaiScope(f.tab)
    expect(inspected).toMatchObject({
      state: 'ready',
      options: [
        { label: 'unrecognized', optionLabel: '전체', textEmpty: true, hasWholeWord: true },
        { label: 'unrecognized', optionLabel: 'unrecognized', textEmpty: true, hasWholeWord: false }
      ]
    })
    expect(JSON.stringify(inspected)).not.toContain('PRIVATE_CARD_LABEL')
    const result = await collectHyundaiApi(f.tab, { from: '2026-10-02', to: '2026-10-02' })
    expect(result.receipt.issues).not.toContain('card_selector_unverified')
    expect(f.fetch).toHaveBeenCalledOnce()
  })

  it('does not accept hidden all-card text when the displayed option label is a custom card', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const option = f.dom.window.document.querySelector('option')!
    option.textContent = '전체'
    option.setAttribute('label', 'PRIVATE_CARD_LABEL')
    const pending = collectHyundaiApi(f.tab, { from: '2026-10-02', to: '2026-10-02' })
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await pending
    expect(result.receipt.issues).toContain('card_selector_unverified')
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it.each(['개인 카드 전체', '가족 카드 전체', '전체(본인)', 'PRIVATE_CARD_NAME 전체'])(
    'does not accept the partial or custom label %s merely because it contains the whole word',
    async (label) => {
      vi.useFakeTimers()
      const f = fixture()
      f.dom.window.document.querySelector('option')!.textContent = label
      const inspected = await inspectHyundaiScope(f.tab)
      expect(inspected).toMatchObject({
        options: [
          { label: 'unrecognized', optionLabel: 'unrecognized', hasWholeWord: true },
          { label: 'unrecognized', optionLabel: 'unrecognized', hasWholeWord: false }
        ]
      })
      const pending = collectHyundaiApi(f.tab, { from: '2026-10-02', to: '2026-10-02' })
      await vi.advanceTimersByTimeAsync(10_000)
      const result = await pending
      expect(result.receipt.issues).toContain('card_selector_unverified')
      expect(f.fetch).not.toHaveBeenCalled()
    }
  )

  it('uses the fixed endpoint, existing session, redirects disabled, and form-urlencoded data', async () => {
    const f = fixture()
    await requestHyundaiApiPage(f.tab, form())
    expect(f.fetch).toHaveBeenCalledOnce()
    const [url, init] = f.fetch.mock.calls[0]
    expect(url).toBe(QUERY)
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', redirect: 'error' })
    expect(init.headers).toMatchObject({ 'X-Requested-With': 'XMLHttpRequest', Referer: HISTORY })
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual(form())
    expect(f.auth).toHaveBeenCalledTimes(2)
  })

  it('uses only the separately observed acquired endpoint with the same authenticated bounds', async () => {
    const f = fixture()
    await requestHyundaiApiPage(f.tab, form(), undefined, 'acquired')
    expect(f.fetch).toHaveBeenCalledOnce()
    const [url, init] = f.fetch.mock.calls[0]
    expect(url).toBe('https://www.hyundaicard.com/cpa/cb/apiCPACB0101_22.hc')
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', redirect: 'error' })
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual(form())
    expect(f.auth).toHaveBeenCalledTimes(2)
    await expect(
      requestHyundaiApiPage(f.tab, form(), undefined, 'unverified' as 'recent')
    ).rejects.toThrow('hyundai_request_invalid')
    expect(f.fetch).toHaveBeenCalledOnce()
  })

  it('rejects missing, extra, unsafe, or expanded request fields before network access', async () => {
    const f = fixture()
    for (const bad of [
      { ...form(), injected: 'private' },
      { ...form(), crno: 'PRIVATE\r\nHEADER' },
      { ...form(), srtDt: '20260928' },
      { ...form(), endDt: '20260230' }
    ])
      await expect(requestHyundaiApiPage(f.tab, bad as HyundaiApiForm)).rejects.toThrow(
        'hyundai_request_invalid'
      )
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('requires the exact history origin and valid session and suppresses raw network errors', async () => {
    const f = fixture()
    f.setUrl('https://www.hyundaicard.com.evil.test/cpa/cb/CPACB0101_01.hc')
    await expect(requestHyundaiApiPage(f.tab, form())).rejects.toThrow('hyundai_history_required')
    f.setUrl(HISTORY)
    f.auth.mockResolvedValue({ state: 'pin_ready' })
    await expect(requestHyundaiApiPage(f.tab, form())).rejects.toThrow(
      'hyundai_authentication_required'
    )
    expect(f.fetch).not.toHaveBeenCalled()
    f.auth.mockResolvedValue({ state: 'signed_in' })
    f.fetch.mockRejectedValue(new Error('PRIVATE_COOKIE_AND_RESPONSE'))
    await expect(requestHyundaiApiPage(f.tab, form())).rejects.toThrow(
      /^hyundai_request_unavailable$/
    )
  })

  it('rejects login HTML, oversized response headers and in-flight navigation', async () => {
    const f = fixture()
    f.fetch.mockResolvedValue(
      new Response('<html>PRIVATE_LOGIN</html>', { headers: { 'content-type': 'text/html' } })
    )
    await expect(requestHyundaiApiPage(f.tab, form())).rejects.toThrow(
      'hyundai_response_unavailable'
    )
    f.fetch.mockResolvedValue(
      new Response('{}', {
        headers: { 'content-type': 'application/json', 'content-length': String(5 * 1024 * 1024) }
      })
    )
    await expect(requestHyundaiApiPage(f.tab, form())).rejects.toThrow('hyundai_response_limit')
    f.fetch.mockImplementation(async () => {
      f.setUrl(HISTORY + '?changed=1')
      return Response.json(payload())
    })
    await expect(requestHyundaiApiPage(f.tab, form())).rejects.toThrow('hyundai_navigation_changed')
  })

  it.each(['fetch', 'body'] as const)(
    'bounds a stalled %s even when the transport ignores abort',
    async (stage) => {
      vi.useFakeTimers()
      const f = fixture()
      if (stage === 'fetch') f.fetch.mockImplementation(() => new Promise<Response>(() => {}))
      else
        f.fetch.mockResolvedValue(
          new Response(new ReadableStream<Uint8Array>(), {
            headers: { 'content-type': 'application/json' }
          })
        )
      const pending = requestHyundaiApiPage(f.tab, form(), undefined, 'acquired')
      const assertion = expect(pending).rejects.toThrow('hyundai_request_timeout')
      await vi.advanceTimersByTimeAsync(20_000)
      await assertion
      expect(f.fetch).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('stops a stalled acquired fetch immediately on cancellation and rejects replacement tab contents', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.fetch.mockImplementation(() => new Promise<Response>(() => {}))
    const controller = new AbortController()
    const pending = requestHyundaiApiPage(f.tab, form(), controller.signal, 'acquired')
    const assertion = expect(pending).rejects.toThrow('hyundai_request_cancelled')
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await assertion
    expect(vi.getTimerCount()).toBe(0)
    f.fetch.mockImplementation(async () => {
      Object.defineProperty(f.tab.view, 'webContents', { value: { ...f.tab.view.webContents } })
      return Response.json(payload())
    })
    await expect(requestHyundaiApiPage(f.tab, form(), undefined, 'acquired')).rejects.toThrow(
      'hyundai_navigation_changed'
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('builds private all-card/all-use requests per day without changing visible filters', async () => {
    const f = fixture()
    const before = f.dom.window.document.querySelector('form')!.outerHTML
    const result = await collectHyundaiApi(f.tab, { from: '2026-09-29', to: '2026-10-02' })
    expect(f.fetch).toHaveBeenCalledTimes(4)
    expect(
      f.fetch.mock.calls.map(([, init]) => new URLSearchParams(String(init.body)).get('srtDt'))
    ).toEqual(['20260929', '20260930', '20261001', '20261002'])
    expect(result.rows).toHaveLength(4)
    expect(result.receipt.pages).toBe(4)
    expect(result.receipt.complete).toBe(false)
    expect(result.receipt.issues).toContain('scope_unverified')
    expect(f.dom.window.document.querySelector('form')!.outerHTML).toBe(before)
    for (const secret of [
      'ALL_PRIVATE_CARDS',
      'PRIVATE_DMFR',
      'PASSWORD_PRIVATE_VALUE',
      '合成',
      '合성',
      '합성 상점'
    ])
      expect(JSON.stringify(result.receipt)).not.toContain(secret)
    for (const [, init] of f.fetch.mock.calls)
      expect(String(init.body)).not.toContain('PASSWORD_PRIVATE_VALUE')
  })

  it('does not guess missing all-card/custom-date controls or date formats', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.dom.window.document.querySelector('label[for="dtClsf_04"]')!.textContent = 'unknown'
    const pending = collectHyundaiApi(f.tab, { from: '2026-10-02', to: '2026-10-02' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await pending).receipt.issues).toEqual(['request_schema_unverified'])
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('requires matching private server echoes of whole-card, zone, use, merchant and direct-date selections', async () => {
    const f = fixture()
    const data = payload() as { bdy: { rcntSummaryInfo: Record<string, unknown> } }
    data.bdy.rcntSummaryInfo.zoneClsf = 'OTHER_PRIVATE_ZONE'
    f.fetch.mockResolvedValue(Response.json(data))
    const result = await collectHyundaiApi(f.tab, { from: '2026-10-02', to: '2026-10-02' })
    expect(result.rows).toEqual([])
    expect(result.receipt.issues).toContain('response_scope_unverified')
    expect(JSON.stringify(result.receipt)).not.toContain('OTHER_PRIVATE_ZONE')
    expect(result.receipt.approvalComplete).toBe(false)
  })

  it('verifies server response period, rejects expanded ranges and honors abort/page limits', async () => {
    const f = fixture()
    expect(
      (await collectHyundaiApi(f.tab, { from: '2026-09-28', to: '2026-10-02' })).receipt.issues
    ).toEqual(['invalid_range'])
    const controller = new AbortController()
    controller.abort()
    expect(
      (
        await collectHyundaiApi(
          f.tab,
          { from: '2026-10-02', to: '2026-10-02' },
          { signal: controller.signal }
        )
      ).receipt.issues
    ).toEqual(['cancelled'])
    expect(f.fetch).not.toHaveBeenCalled()
    const limited = await collectHyundaiApi(
      f.tab,
      { from: '2026-10-01', to: '2026-10-02' },
      { maxPages: 1 }
    )
    expect(limited.receipt.pages).toBe(1)
    expect(limited.receipt.issues).toContain('page_limit')
    f.fetch.mockResolvedValue(Response.json(payload([], '20260901')))
    const wrongPeriod = await collectHyundaiApi(f.tab, { from: '2026-10-02', to: '2026-10-02' })
    expect(wrongPeriod.rows).toEqual([])
    expect(wrongPeriod.receipt.issues).toContain('response_range_unverified')
  })
})

describe('Hyundai acquired value-free inspection', () => {
  function acquiredFixture(items: object[] = []): ReturnType<typeof fixture> {
    const f = fixture()
    f.dom.window.document.querySelector<HTMLInputElement>('[name="dmfrClsf"]')!.value = ''
    const radio = f.dom.window.document.createElement('input')
    Object.assign(radio, {
      type: 'radio',
      name: 'listClsf',
      id: 'listClsf_02',
      value: 'PRIVATE_ACQUIRED_MODE'
    })
    f.dom.window.document.querySelector('form')!.append(radio)
    f.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
      const data = Object.fromEntries(new URLSearchParams(String(init.body)))
      return Response.json({
        bdy: {
          rcntSummaryInfo: { ...data, usplClsf: '', totUseCnt: items.length },
          acqrUseItmList: items
        }
      })
    })
    return f
  }

  it('queries only fixed acquired daily endpoints and returns field shapes without semantic claims or values', async () => {
    const f = acquiredFixture([
      {
        recordId: 'OFFICIAL_SYNTHETIC_EVENT_IDENTIFIER',
        useDt: '20261002',
        avDt: '20260801',
        avNo: '87654321',
        useAmt: '-35000',
        excm: '0',
        merchant: 'PRIVATE_CUSTOMER_MERCHANT',
        cdno: '0000-00**-****-5432',
        token: 'PRIVATE_TOKEN',
        nested: { eventId: 'NESTED_EVENT_IDENTIFIER' }
      },
      { recordId: 'SECOND_IDENTIFIER', useDt: '20261002', useAmt: 42000, excm: 150 },
      { recordId: '', useAmt: 0, excm: 0 },
      { recordId: null, useAmt: 'not verified', excm: 0 }
    ])
    const before = f.dom.window.document.querySelector('form')!.outerHTML
    const result = await inspectHyundaiAcquired(f.tab, { from: '2026-10-02', to: '2026-10-02' })
    expect(result).toMatchObject({
      state: 'ready',
      pages: 1,
      rowCount: 4,
      reportedTotal: 4,
      scopeVerified: true,
      amountSigns: { positive: 1, negative: 1, zero: 1, unverified: 1 },
      issues: ['acquired_cancellation_semantics_unverified']
    })
    expect(result.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'recordId',
          types: ['null', 'string'],
          nonemptyCount: 2,
          distinctCount: 2,
          dateShapeCount: 0
        }),
        expect.objectContaining({ name: 'useDt', dateShapeCount: 2, requestedDayMatchCount: 2 }),
        expect.objectContaining({ name: 'avDt', dateShapeCount: 1, requestedDayMatchCount: 0 }),
        expect.objectContaining({ name: 'nested.eventId', distinctCount: 1 })
      ])
    )
    expect(f.fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://www.hyundaicard.com/cpa/cb/apiCPACB0101_22.hc'
    ])
    expect(new URLSearchParams(String(f.fetch.mock.calls[0][1].body)).get('listClsf')).toBe(
      'PRIVATE_ACQUIRED_MODE'
    )
    expect(f.dom.window.document.querySelector('form')!.outerHTML).toBe(before)
    const serialized = JSON.stringify(result)
    for (const value of [
      'OFFICIAL_SYNTHETIC_EVENT_IDENTIFIER',
      'SECOND_IDENTIFIER',
      'NESTED_EVENT_IDENTIFIER',
      '20260801',
      '87654321',
      '35000',
      '42000',
      'PRIVATE_CUSTOMER_MERCHANT',
      '0000-00**-****-5432',
      'PRIVATE_TOKEN',
      'PRIVATE_ACQUIRED_MODE',
      'ALL_PRIVATE_CARDS'
    ])
      expect(serialized).not.toContain(value)
    expect(result.fields.some((field) => field.name === 'token')).toBe(false)
  })

  it('bounds four daily requests and retains empty query evidence without claiming cancellation coverage', async () => {
    const f = acquiredFixture()
    const result = await inspectHyundaiAcquired(f.tab, { from: '2026-09-29', to: '2026-10-02' })
    expect(result).toMatchObject({
      state: 'ready',
      pages: 4,
      rowCount: 0,
      reportedTotal: 0,
      fields: [],
      scopeVerified: true,
      issues: ['acquired_cancellation_semantics_unverified']
    })
    expect(
      f.fetch.mock.calls.map(([, init]) => new URLSearchParams(String(init.body)).get('srtDt'))
    ).toEqual(['20260929', '20260930', '20261001', '20261002'])
  })

  it('bounds the whole inspection at sixty seconds and retains only completed response shapes', async () => {
    vi.useFakeTimers()
    const f = acquiredFixture()
    const original = f.fetch.getMockImplementation()!
    f.fetch.mockImplementation(
      (url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const delayed = setTimeout(() => {
            void original(url, init).then(resolve, reject)
          }, 19_000)
          init.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(delayed)
              reject(new Error('PRIVATE_TRANSPORT_ABORT'))
            },
            { once: true }
          )
        })
    )
    const pending = inspectHyundaiAcquired(f.tab, { from: '2026-09-29', to: '2026-10-02' })
    await vi.advanceTimersByTimeAsync(60_000)
    const result = await pending
    expect(result).toMatchObject({
      state: 'unavailable',
      pages: 4,
      rowCount: 0,
      scopeVerified: false,
      issues: ['hyundai_request_timeout']
    })
    expect(f.fetch).toHaveBeenCalledTimes(4)
    expect(JSON.stringify(result)).not.toContain('PRIVATE_TRANSPORT_ABORT')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects invalid dates, expanded ranges, unsupported pages, signed-out sessions and abort before requests', async () => {
    const f = acquiredFixture()
    for (const range of [
      { from: '2026-09-28', to: '2026-10-02' },
      { from: '2026-10-03', to: '2026-10-02' },
      { from: '2026-02-30', to: '2026-02-30' }
    ])
      expect((await inspectHyundaiAcquired(f.tab, range)).issues).toEqual(['invalid_range'])
    f.setUrl('https://www.hyundaicard.com.evil.test/cpa/cb/CPACB0101_01.hc')
    expect(
      (await inspectHyundaiAcquired(f.tab, { from: '2026-10-02', to: '2026-10-02' })).issues
    ).toEqual(['hyundai_history_required'])
    f.setUrl(HISTORY)
    f.auth.mockResolvedValue({ state: 'pin_ready' })
    expect(
      (await inspectHyundaiAcquired(f.tab, { from: '2026-10-02', to: '2026-10-02' })).issues
    ).toEqual(['hyundai_authentication_required'])
    const controller = new AbortController()
    controller.abort()
    expect(
      (
        await inspectHyundaiAcquired(
          f.tab,
          { from: '2026-10-02', to: '2026-10-02' },
          controller.signal
        )
      ).issues
    ).toEqual(['cancelled'])
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it.each(['srtDt', 'endDt', 'crno', 'useClsf', 'zoneClsf', 'usplClsf', 'dtClsf'])(
    'does not verify a mismatched %s echo or expose its value',
    async (field) => {
      const f = acquiredFixture()
      const original = f.fetch.getMockImplementation()!
      f.fetch.mockImplementation(async (url: string, init: RequestInit) => {
        const response = await original(url, init)
        const data = await response.json()
        data.bdy.rcntSummaryInfo[field] = 'PRIVATE_WRONG_ECHO'
        return Response.json(data)
      })
      const result = await inspectHyundaiAcquired(f.tab, { from: '2026-10-02', to: '2026-10-02' })
      expect(result.scopeVerified).toBe(false)
      expect(result.issues).toContain(
        field === 'srtDt' || field === 'endDt'
          ? 'response_range_unverified'
          : 'response_scope_unverified'
      )
      expect(JSON.stringify(result)).not.toContain('PRIVATE_WRONG_ECHO')
    }
  )

  it('marks count mismatches and caps without treating array length or negative amounts as completeness', async () => {
    const f = acquiredFixture(Array.from({ length: 630 }, () => ({ useAmt: -10, excm: 0 })))
    const original = f.fetch.getMockImplementation()!
    f.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      const response = await original(url, init)
      const data = await response.json()
      data.bdy.rcntSummaryInfo.totUseCnt = 640
      return Response.json(data)
    })
    const result = await inspectHyundaiAcquired(f.tab, { from: '2026-10-02', to: '2026-10-02' })
    expect(result.issues).toEqual(
      expect.arrayContaining([
        'daily_row_limit_possible',
        'total_count_mismatch',
        'acquired_cancellation_semantics_unverified'
      ])
    )
    expect(result.amountSigns.negative).toBe(630)
  })

  it('bounds field metadata and omits private/dynamic keys without returning any scalar', async () => {
    const f = acquiredFixture()
    const row = {
      PRIVATE_FIELD: 'PRIVATE_VALUE',
      record12345678: 'DYNAMIC_VALUE',
      ...Object.fromEntries(Array.from({ length: 110 }, (_, i) => [`field${i}`, 'VALUE']))
    }
    const response = {
      bdy: {
        rcntSummaryInfo: { ...form(), dmfrClsf: '', usplClsf: '', totUseCnt: 1 },
        acqrUseItmList: [row]
      }
    }
    f.fetch.mockResolvedValue(Response.json(response))
    const result = await inspectHyundaiAcquired(f.tab, { from: '2026-10-02', to: '2026-10-02' })
    expect(result.fields.length).toBeLessThanOrEqual(100)
    expect(result.issues).toContain('acquired_diagnostic_fields_truncated')
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE_FIELD|PRIVATE_VALUE|record12345678|DYNAMIC_VALUE/
    )
  })

  it('suppresses private service/transport failures and refuses malformed acquired lists', async () => {
    const f = acquiredFixture()
    f.fetch.mockRejectedValue(new Error('PRIVATE_COOKIE_NETWORK_FAILURE'))
    const failed = await inspectHyundaiAcquired(f.tab, { from: '2026-10-02', to: '2026-10-02' })
    expect(failed).toMatchObject({ state: 'unavailable', issues: ['hyundai_request_unavailable'] })
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_COOKIE_NETWORK_FAILURE')
    f.fetch.mockResolvedValue(Response.json({ bdy: { acqrUseItmList: 'PRIVATE_RESPONSE' } }))
    const malformed = await inspectHyundaiAcquired(f.tab, { from: '2026-10-02', to: '2026-10-02' })
    expect(malformed.state).toBe('unavailable')
    expect(malformed.issues).toContain('acquired_response_schema_unverified')
    expect(JSON.stringify(malformed)).not.toContain('PRIVATE_RESPONSE')
  })
})
