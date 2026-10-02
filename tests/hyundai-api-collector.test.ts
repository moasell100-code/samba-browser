import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../src/main/browser/tab-manager'
import { pageBridge } from '../src/main/browser/page-bridge'
import {
  collectHyundaiApi,
  inspectHyundaiScope,
  parseHyundaiApiPage,
  requestHyundaiApiPage,
  type HyundaiApiForm
} from '../src/main/finance/hyundai-api-collector'

const HISTORY = 'https://www.hyundaicard.com/cpa/cb/CPACB0101_01.hc'
const QUERY = 'https://www.hyundaicard.com/cpa/cb/apiCPACB0101_21.hc'
const windows: JSDOM[] = []
afterEach(() => {
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
      rcntSummaryInfo: { totUseCnt: total, srtDt: day, endDt: day },
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

describe('Hyundai private approval response normalization', () => {
  it('normalizes observed fields without inventing approval, currency, or cancellation certainty', () => {
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
    expect(result.rows[0].needsReview).toContain('currency_unverified')
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
    'recognizes only verified non-cancellation code %s with explicit KRW currency',
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
      expect(noCurrency.rows[0].netAmount).toBeNull()
      expect(noCurrency.rows[0].needsReview).toContain('currency_unverified')
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
        cancellationAmount: null
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
  it.each(['전체', '전체 카드', '카드 전체', '모든 카드'])(
    'accepts the verified all-card option label %s without exposing its value',
    async (label) => {
      const f = fixture()
      f.dom.window.document.querySelector('select option')!.textContent = label
      const result = await collectHyundaiApi(f.tab, { from: '2026-10-02', to: '2026-10-02' })
      expect(f.fetch).toHaveBeenCalledOnce()
      expect(result.rows).toHaveLength(1)
      expect(result.receipt.approvalComplete).toBe(false)
    }
  )

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
    const f = fixture()
    f.dom.window.document.querySelector('label[for="dtClsf_04"]')!.textContent = 'unknown'
    expect(
      (await collectHyundaiApi(f.tab, { from: '2026-10-02', to: '2026-10-02' })).receipt.issues
    ).toEqual(['request_schema_unverified'])
    expect(f.fetch).not.toHaveBeenCalled()
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
