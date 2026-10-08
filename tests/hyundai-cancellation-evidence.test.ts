import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../src/main/browser/tab-manager'
import { pageBridge } from '../src/main/browser/page-bridge'
import type { HyundaiApiForm } from '../src/main/finance/hyundai-api-collector'
import { inspectHyundaiCancellationEvidence } from '../src/main/finance/hyundai-cancellation-evidence'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../src/main/finance/hyundai-api-collector', async (original) => ({
  ...(await original<typeof import('../src/main/finance/hyundai-api-collector')>()),
  requestHyundaiApiPage: mocks.request
}))
const HISTORY = 'https://www.hyundaicard.com/cpa/cb/CPACB0101_01.hc'
const RANGE = { from: '2026-08-03', to: '2026-08-03' }

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    useDt: '20260803',
    avDt: '20260701',
    avDttm: '20260701123000',
    avNo: '12345678',
    cancYn: 'Y',
    calnMarkVl: '-',
    useAmt: '12000',
    excm: '150',
    slipNo: 'PRIVATE_REFUND_SLIP',
    crno: 'PRIVATE_CARD_REFERENCE',
    cdno: '1234567890125432',
    useMrchNm: 'PRIVATE_MERCHANT',
    cookie: 'PRIVATE_COOKIE',
    token: 'PRIVATE_TOKEN',
    ...overrides
  }
}
function plan(day: string): Record<string, unknown> {
  return {
    ok: true,
    data: {
      crno: 'ALL_PRIVATE_CARDS',
      dmfrClsf: '',
      dtClsf: 'PRIVATE_DIRECT_PERIOD',
      endDt: day.replaceAll('-', ''),
      listClsf: 'PRIVATE_ACQUIRED_LIST',
      sortType: '0',
      srtDt: day.replaceAll('-', ''),
      useClsf: 'ALL_PRIVATE_USE',
      usplClsf: 'ALL_PRIVATE_MERCHANTS',
      zoneClsf: 'ALL_PRIVATE_ZONE'
    },
    cardTails: [{ crno: 'PRIVATE_CARD_REFERENCE', status: 'matched', last4: '5432' }]
  }
}
function payload(form: HyundaiApiForm, rows: unknown[], total: unknown = rows.length): object {
  return {
    bdy: {
      acqrUseItmList: rows,
      rcntSummaryInfo: { ...form, usplClsf: '', totUseCnt: total },
      token: 'PRIVATE_RESPONSE_TOKEN'
    }
  }
}
function fixture(): {
  tab: Tab
  wc: EventEmitter
  execute: ReturnType<typeof vi.fn>
  auth: ReturnType<typeof vi.spyOn<typeof pageBridge, 'hyundaiAuth'>>
  setUrl(value: string): void
} {
  let url = HISTORY
  const execute = vi.fn(async (script: string, gesture: boolean) => {
    expect(gesture).toBe(false)
    expect(script).toContain('listClsf_02')
    const day = /"(2026-\d{2}-\d{2})"/.exec(script)?.[1] ?? RANGE.from
    return plan(day)
  })
  const wc = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getURL: () => url,
    executeJavaScript: execute
  })
  const tab = { profile: 'default', view: { webContents: wc } } as unknown as Tab
  const auth = vi.spyOn(pageBridge, 'hyundaiAuth').mockResolvedValue({ state: 'signed_in' })
  return {
    tab,
    wc,
    execute,
    auth,
    setUrl: (value): void => {
      url = value
    }
  }
}
beforeEach(() => {
  mocks.request
    .mockReset()
    .mockImplementation(async (_tab, form: HyundaiApiForm) =>
      payload(form, [row(), row({ cancYn: 'N', calnMarkVl: '', slipNo: 'PRIVATE_POSITIVE_SLIP' })])
    )
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Hyundai fixed acquired cancellation evidence counts', () => {
  it('replays only API22 and returns sign, original identity and repeatability counts without values or hashes', async () => {
    const f = fixture()
    const result = await inspectHyundaiCancellationEvidence(f.tab, RANGE)
    expect(result).toMatchObject({
      state: 'ready',
      dateBasis: 'unverified',
      eventIdentity: 'unverified',
      pages: 2,
      scopeVerified: true,
      reportedTotal: 2,
      counts: {
        rows: 2,
        cancellationFlagY: 1,
        minusPrefix: 1,
        flagAndMinus: 1,
        flagWithoutMinus: 0,
        minusWithoutFlag: 0,
        numericComponentsValid: 2,
        displayedNegative: 1,
        displayedNonnegative: 1,
        refundRows: 1,
        refundSlipNoPresent: 1,
        refundSlipNoUniqueRows: 1,
        refundSlipNoDuplicateRows: 0,
        refundSlipNoMatchesPositiveRows: 0,
        refundUseDateMatchesRequest: 1,
        refundApprovalDateValid: 1,
        refundApprovalDateTimeValid: 1,
        refundApprovalDatesAgree: 1,
        refundApprovalAfterUseDate: 0,
        refundOriginalIdentityComplete: 1,
        refundApprovalNumberMissing: 0,
        refundCardReferenceMissing: 0,
        refundNormalizedCardTailMissing: 0,
        refundCardTailMissing: 0,
        refundMerchantMissing: 0
      },
      repeat: { comparedDays: 1, stableDays: 1, changedDays: 0, identityUnverifiedDays: 0 },
      issues: []
    })
    expect(mocks.request).toHaveBeenCalledTimes(2)
    for (const args of mocks.request.mock.calls) {
      expect(args[0]).toBe(f.tab)
      expect(args[1]).toMatchObject({ srtDt: '20260803', endDt: '20260803' })
      expect(args[2]).toBeInstanceOf(AbortSignal)
      expect(args[3]).toBe('acquired')
    }
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|12345678|5432|12000|12150|[a-f0-9]{64}/)
    expect(f.wc.listenerCount('destroyed')).toBe(0)
    expect(f.wc.listenerCount('did-start-navigation')).toBe(0)
  })

  it('uses the exact displayed prefix and rejects a double minus or comma-formatted Number input', async () => {
    const f = fixture()
    mocks.request.mockImplementation(async (_tab, form: HyundaiApiForm) =>
      payload(form, [
        row({ slipNo: 'A', cancYn: 'Y', calnMarkVl: '', useAmt: '12000' }),
        row({ slipNo: 'B', cancYn: 'N', calnMarkVl: '-' }),
        row({ slipNo: 'C', useAmt: '-12000', excm: '0' }),
        row({ slipNo: 'D', useAmt: '12,000' }),
        row({ slipNo: 'E', excm: null }),
        row({ slipNo: 'F', useAmt: '-12000', excm: '0', calnMarkVl: '' })
      ])
    )
    const result = await inspectHyundaiCancellationEvidence(f.tab, RANGE)
    expect(result.counts).toMatchObject({
      cancellationFlagY: 5,
      minusPrefix: 4,
      flagAndMinus: 3,
      flagWithoutMinus: 2,
      minusWithoutFlag: 1,
      numericComponentsValid: 4,
      numericComponentsInvalid: 2,
      displayedAmountInvalid: 3,
      displayedNegative: 2,
      refundRows: 1
    })
    expect(result.eventIdentity).toBe('unverified')
  })

  it('finds duplicate refund slip IDs and positive/refund collisions across different query days', async () => {
    const f = fixture()
    mocks.request.mockImplementation(async (_tab, form: HyundaiApiForm) =>
      payload(
        form,
        form.srtDt === '20260701'
          ? [row({ useDt: '20260701', cancYn: 'N', calnMarkVl: '', slipNo: 'SAME_SLIP' })]
          : [
              row({ useDt: '20260702', slipNo: 'SAME_SLIP' }),
              row({ useDt: '20260702', slipNo: 'SAME_SLIP' })
            ]
      )
    )
    const result = await inspectHyundaiCancellationEvidence(f.tab, {
      from: '2026-07-01',
      to: '2026-07-02'
    })
    expect(result).toMatchObject({
      state: 'partial',
      pages: 4,
      counts: {
        rows: 3,
        refundRows: 2,
        refundSlipNoPresent: 2,
        refundSlipNoUniqueRows: 0,
        refundSlipNoDuplicateRows: 2,
        refundSlipNoMatchesPositiveRows: 2
      },
      repeat: { comparedDays: 2, stableDays: 1, identityUnverifiedDays: 1 }
    })
  })

  it.each([
    ['slipNo', 'OTHER_SLIP'],
    ['useAmt', '12001'],
    ['useDt', '20260804'],
    ['avDt', '20260702'],
    ['avDttm', '20260701123100'],
    ['avNo', '87654321'],
    ['crno', 'OTHER_PRIVATE_CARD'],
    ['useMrchNm', 'OTHER_PRIVATE_MERCHANT'],
    ['calnMarkVl', '']
  ])('does not call a refund ID stable after %s changes', async (field, value) => {
    const f = fixture()
    let requests = 0
    mocks.request.mockImplementation(async (_tab, form: HyundaiApiForm) =>
      payload(form, [row(++requests === 2 ? { [field]: value } : {})])
    )
    const result = await inspectHyundaiCancellationEvidence(f.tab, RANGE)
    expect(result).toMatchObject({
      state: 'partial',
      repeat: { changedDays: 1, stableDays: 0 }
    })
    expect(result.issues).toContain('repeat_snapshot_changed')
  })

  it('keeps missing IDs and conflicted or future original dates visible as counts', async () => {
    const f = fixture()
    mocks.request.mockImplementation(async (_tab, form: HyundaiApiForm) =>
      payload(form, [
        row({ slipNo: '', avDt: '20260804', avDttm: '20260804123000' }),
        row({
          slipNo: 'OTHER',
          avDt: '20260702',
          avDttm: '20260701123000',
          cdno: '****',
          crno: ''
        }),
        row({ slipNo: 'THIRD', avDt: '20260230', avDttm: 'invalid' })
      ])
    )
    const result = await inspectHyundaiCancellationEvidence(f.tab, RANGE)
    expect(result).toMatchObject({
      state: 'partial',
      counts: {
        refundSlipNoMissing: 1,
        refundApprovalAfterUseDate: 1,
        refundApprovalDatesAgree: 1,
        refundOriginalIdentityComplete: 0
      },
      repeat: { identityUnverifiedDays: 1, stableDays: 0 }
    })
    expect(JSON.stringify(result)).not.toContain('invalid')
  })

  it.each([
    ['2026-06-30', '2026-07-01'],
    ['2026-08-01', '2026-08-05'],
    ['2026-08-04', '2026-08-01'],
    ['2026-09-31', '2026-09-31'],
    ['9999-01-01', '9999-01-01']
  ])('rejects invalid or unapproved dates %s..%s before reading a page', async (from, to) => {
    const f = fixture()
    expect(await inspectHyundaiCancellationEvidence(f.tab, { from, to })).toMatchObject({
      state: 'invalid_range'
    })
    expect(f.auth).not.toHaveBeenCalled()
    expect(f.execute).not.toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it.each(['auth', 'url', 'profile', 'scope'] as const)(
    'stops on %s changes before the replay query',
    async (fault) => {
      const f = fixture()
      mocks.request.mockImplementationOnce(async (_tab, form: HyundaiApiForm) => {
        if (fault === 'auth') f.auth.mockResolvedValue({ state: 'registration_required' })
        if (fault === 'url') f.setUrl('https://attacker.example/cpa/cb/CPACB0101_01.hc')
        if (fault === 'profile') (f.tab as unknown as { profile: string }).profile = 'other'
        if (fault === 'scope') f.execute.mockResolvedValue(plan('2026-08-04'))
        return payload(form, [row()])
      })
      const result = await inspectHyundaiCancellationEvidence(f.tab, RANGE)
      expect(result.state).toBe('partial')
      expect(result.scopeVerified).toBe(false)
      expect(mocks.request).toHaveBeenCalledTimes(1)
    }
  )

  it('does not issue a request after a pending page plan is aborted', async () => {
    const f = fixture()
    let resolve!: (value: unknown) => void
    f.execute.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const abort = new AbortController()
    const pending = inspectHyundaiCancellationEvidence(f.tab, RANGE, abort.signal)
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1))
    abort.abort()
    expect(await pending).toMatchObject({ state: 'unavailable', issues: ['cancelled'] })
    resolve(plan(RANGE.from))
    await Promise.resolve()
    expect(mocks.request).not.toHaveBeenCalled()
    expect(f.wc.listenerCount('destroyed')).toBe(0)
  })

  it('sanitizes arbitrary transport failures and stops before another request', async () => {
    const f = fixture()
    mocks.request.mockRejectedValueOnce(new Error('PRIVATE_COOKIE PRIVATE_ACCOUNT 918273'))
    const result = await inspectHyundaiCancellationEvidence(f.tab, RANGE)
    expect(result).toMatchObject({ state: 'partial', issues: ['probe_unavailable'] })
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|918273/)
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })

  it('does not certify a truncated daily response even when its total matches', async () => {
    const f = fixture()
    mocks.request.mockImplementation(async (_tab, form: HyundaiApiForm) =>
      payload(
        form,
        Array.from({ length: 630 }, (_, index) =>
          row({ cancYn: 'N', calnMarkVl: '', slipNo: 'POSITIVE_' + index })
        )
      )
    )
    expect(await inspectHyundaiCancellationEvidence(f.tab, RANGE)).toMatchObject({
      state: 'partial',
      counts: { rows: 630 },
      issues: ['daily_row_limit_possible']
    })
  })

  it('detects a positive slip collision appearing only on the second snapshot', async () => {
    const f = fixture()
    let call = 0
    mocks.request.mockImplementation(async (_tab, form: HyundaiApiForm) =>
      payload(form, [
        row(),
        row({
          cancYn: 'N',
          calnMarkVl: '',
          slipNo: ++call === 1 ? 'PRIVATE_POSITIVE_SLIP' : 'PRIVATE_REFUND_SLIP'
        })
      ])
    )
    expect(await inspectHyundaiCancellationEvidence(f.tab, RANGE)).toMatchObject({
      state: 'partial',
      counts: { refundSlipNoMatchesPositiveRows: 1 },
      issues: ['repeat_identity_unverified']
    })
  })

  it('does not treat equal replay sizes as a verified count when the reported total disagrees', async () => {
    const f = fixture()
    mocks.request.mockImplementation(async (_tab, form: HyundaiApiForm) =>
      payload(form, [row()], 2)
    )
    expect(await inspectHyundaiCancellationEvidence(f.tab, RANGE)).toMatchObject({
      state: 'partial',
      reportedTotal: 2,
      counts: { rows: 1 },
      issues: ['total_count_mismatch']
    })
  })

  it('rejects a response whose date echo differs from the fixed daily request', async () => {
    const f = fixture()
    mocks.request.mockImplementation(async (_tab, form: HyundaiApiForm) =>
      payload({ ...form, srtDt: '20260804' }, [row()])
    )
    expect(await inspectHyundaiCancellationEvidence(f.tab, RANGE)).toMatchObject({
      state: 'partial',
      scopeVerified: false,
      issues: ['response_range_unverified']
    })
  })

  it('does not read cached rows in an issuer error response', async () => {
    const f = fixture()
    mocks.request.mockImplementation(async (_tab, form: HyundaiApiForm) => ({
      bdy: {
        ...(payload(form, [row()]) as { bdy: object }).bdy,
        error_code: 'PRIVATE_ERROR',
        error_message: 'PRIVATE_MESSAGE'
      }
    }))
    const result = await inspectHyundaiCancellationEvidence(f.tab, RANGE)
    expect(result).toMatchObject({
      state: 'partial',
      counts: { rows: 0 },
      issues: ['service_error']
    })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })

  it('bounds an unsettled request and releases its navigation listeners', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-08T03:00:00Z'))
    const f = fixture()
    mocks.request.mockImplementationOnce(() => new Promise(() => undefined))
    const pending = inspectHyundaiCancellationEvidence(f.tab, RANGE)
    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(21_000)
    expect(await pending).toMatchObject({ state: 'partial', issues: ['request_timeout'] })
    expect(f.wc.listenerCount('destroyed')).toBe(0)
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })

  it('never starts authentication for an already aborted call', async () => {
    const f = fixture()
    const abort = new AbortController()
    abort.abort()
    expect(await inspectHyundaiCancellationEvidence(f.tab, RANGE, abort.signal)).toMatchObject({
      state: 'unavailable',
      issues: ['cancelled']
    })
    expect(f.auth).not.toHaveBeenCalled()
    expect(f.execute).not.toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it.each(['', '+'])(
    'does not let a positive Y posting with prefix %s invalidate negative refund replay',
    async (prefix) => {
      const f = fixture()
      mocks.request.mockImplementation(async (_tab, form: HyundaiApiForm) =>
        payload(form, [row(), row({ cancYn: 'Y', calnMarkVl: prefix, slipNo: '', avNo: '' })])
      )
      expect(await inspectHyundaiCancellationEvidence(f.tab, RANGE)).toMatchObject({
        state: 'ready',
        counts: {
          cancellationFlagY: 2,
          flagWithoutMinus: 1,
          displayedNonnegative: 1,
          refundRows: 1,
          refundSlipNoPresent: 1,
          refundOriginalIdentityComplete: 1
        },
        repeat: { stableDays: 1, identityUnverifiedDays: 0 }
      })
    }
  )

  it('counts a positive Y posting that shares a negative refund slip without calling it a second refund', async () => {
    const f = fixture()
    mocks.request.mockImplementation(async (_tab, form: HyundaiApiForm) =>
      payload(form, [row(), row({ cancYn: 'Y', calnMarkVl: '' })])
    )
    expect(await inspectHyundaiCancellationEvidence(f.tab, RANGE)).toMatchObject({
      counts: { refundRows: 1, refundSlipNoDuplicateRows: 0, refundSlipNoMatchesPositiveRows: 1 },
      repeat: { stableDays: 1, identityUnverifiedDays: 0 }
    })
  })

  it.each([
    [{ avNo: '' }, { refundApprovalNumberMissing: 1, refundOriginalIdentityComplete: 0 }],
    [{ crno: '' }, { refundCardReferenceMissing: 1, refundOriginalIdentityComplete: 1 }],
    [
      { cdno: '****************' },
      {
        refundNormalizedCardTailMissing: 1,
        refundCardTailMissing: 0,
        refundOriginalIdentityComplete: 1
      }
    ],
    [
      { cdno: '****************', crno: '' },
      {
        refundCardReferenceMissing: 1,
        refundNormalizedCardTailMissing: 1,
        refundCardTailMissing: 1,
        refundOriginalIdentityComplete: 0
      }
    ],
    [
      { useMrchNm: '', mrchNm: '' },
      { refundMerchantMissing: 1, refundOriginalIdentityComplete: 0 }
    ]
  ])(
    'reports missing identity components without returning their values',
    async (overrides, counts) => {
      const f = fixture()
      mocks.request.mockImplementation(async (_tab, form: HyundaiApiForm) =>
        payload(form, [row(overrides)])
      )
      const result = await inspectHyundaiCancellationEvidence(f.tab, RANGE)
      expect(result.counts).toMatchObject(counts)
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|5432|12345678/)
    }
  )

  it('reuses the bounded first-plan retry while the official history form initializes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-08T03:00:00Z'))
    const f = fixture()
    f.execute.mockResolvedValueOnce({ ok: false, issue: 'request_schema_unverified' })
    const pending = inspectHyundaiCancellationEvidence(f.tab, RANGE)
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1))
    expect(mocks.request).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)
    expect(await pending).toMatchObject({ state: 'ready', pages: 2 })
    expect(f.execute).toHaveBeenCalledTimes(3)
    expect(mocks.request).toHaveBeenCalledTimes(2)
  })

  it('stops after the ten-second first-plan deadline without issuing an API request', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-08T03:00:00Z'))
    const f = fixture()
    f.execute.mockResolvedValue({ ok: false, issue: 'request_schema_unverified' })
    const pending = inspectHyundaiCancellationEvidence(f.tab, RANGE)
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toMatchObject({
      state: 'unavailable',
      pages: 0,
      issues: ['request_schema_unverified']
    })
    expect(mocks.request).not.toHaveBeenCalled()
    expect(f.wc.listenerCount('destroyed')).toBe(0)
  })
})
