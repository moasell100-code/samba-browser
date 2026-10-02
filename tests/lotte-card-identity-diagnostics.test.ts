import { describe, expect, it } from 'vitest'
import { lotteCardIdentityDiagnostics } from '../src/main/finance/lotte-card-identity-diagnostics'

describe('Lotte detail card identity schema diagnostics', () => {
  it('returns public field names and card-format flags while never returning private values', () => {
    const result = lotteCardIdentityDiagnostics({
      Param: {
        cardNo: '9182-****-****-7364',
        cdno: '9182736450918273',
        password: 'SYNTHETIC_PRIVATE_PASSWORD',
        accountName: 'SYNTHETIC_PRIVATE_ACCOUNT_NAME',
        amount: '735826',
        encCdno: 'SYNTHETIC_PRIVATE_OPAQUE_REFERENCE'
      }
    })
    expect(result).toEqual([
      'detail_param_field_cardNo',
      'detail_param_card_format_cardNo',
      'detail_param_field_cdno',
      'detail_param_card_format_cdno',
      'detail_param_field_password',
      'detail_param_field_accountName',
      'detail_param_field_amount',
      'detail_param_field_encCdno'
    ])
    const encoded = JSON.stringify(result)
    for (const secret of ['9182', '7364', '9182736450918273', 'SYNTHETIC_PRIVATE', '735826'])
      expect(encoded).not.toContain(secret)
  })

  it('does not invoke getters or include inherited field names', () => {
    const param = Object.create(null) as Record<string, unknown>
    param.cardNo = '1234-****-****-5678'
    Object.defineProperty(param, 'secret', {
      enumerable: true,
      get: (): never => {
        throw new Error('must not read')
      }
    })
    expect(lotteCardIdentityDiagnostics({ Param: param })).toEqual([
      'detail_param_field_cardNo',
      'detail_param_card_format_cardNo'
    ])
    const response = Object.create({ Param: { cardNo: '1234-****-****-5678' } }) as object
    expect(lotteCardIdentityDiagnostics(response)).toEqual(['detail_param_unavailable'])
    const accessor = Object.defineProperty({}, 'Param', {
      get: (): never => {
        throw new Error('must not read')
      }
    })
    expect(lotteCardIdentityDiagnostics(accessor)).toEqual(['detail_param_unavailable'])
    expect(
      lotteCardIdentityDiagnostics({ Param: Object.create({ inheritedPrivate: 'unused' }) })
    ).toEqual(['detail_param_unavailable'])
  })

  it('rejects invalid or number-bearing schema names and bounds entry counts', () => {
    const param = { account91827364: 'unused', 'wrong-key': 'unused' }
    const bounded: Record<string, unknown> = {
      cardNo: '1'.repeat(13),
      ['x'.repeat(42)]: 'unused',
      ...param
    }
    expect(lotteCardIdentityDiagnostics({ Param: bounded })).toEqual(['detail_param_field_cardNo'])
    const oversized = Object.fromEntries(
      Array.from({ length: 81 }, (_, index) => [`field${index}`, 'unused'])
    )
    expect(lotteCardIdentityDiagnostics({ Param: oversized })).toEqual(['detail_param_field_limit'])
  })

  it('emits card-format flags only for matching string fields and bounded display syntax', () => {
    expect(
      lotteCardIdentityDiagnostics({
        Param: {
          cardNo: '1'.repeat(14),
          cdno: '*'.repeat(30),
          other: '1'.repeat(16),
          amount: '1'.repeat(16),
          approvalNo: '1'.repeat(31),
          cardNumber: 91827364509182,
          maskedCard: '1234 **** **** ABCD'
        }
      })
    ).toEqual([
      'detail_param_field_cardNo',
      'detail_param_card_format_cardNo',
      'detail_param_field_cdno',
      'detail_param_card_format_cdno',
      'detail_param_field_other',
      'detail_param_field_amount',
      'detail_param_field_approvalNo',
      'detail_param_field_cardNumber',
      'detail_param_field_maskedCard'
    ])
  })

  it('does not stringify non-object envelopes or unsupported Param values', () => {
    for (const response of [
      null,
      undefined,
      1,
      'SYNTHETIC_PRIVATE',
      [],
      {},
      { Param: [] },
      { Param: 'SYNTHETIC_PRIVATE' }
    ])
      expect(lotteCardIdentityDiagnostics(response)).toEqual(['detail_param_unavailable'])
  })
})
