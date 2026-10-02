import { describe, expect, it } from 'vitest'
import { lotteMethodDiagnostics } from '../src/main/finance/lotte-method-diagnostics'

describe('bounded Lotte public method diagnostics', () => {
  it('returns only public word flags and syntax presence for a composite method', () => {
    expect(lotteMethodDiagnostics('국내 체크카드(일시불) [승인-1/거래]')).toEqual([
      'detail_method_length_22',
      'detail_method_token_debit',
      'detail_method_token_card',
      'detail_method_token_single_payment',
      'detail_method_token_approval',
      'detail_method_token_transaction',
      'detail_method_token_domestic',
      'detail_method_token_debit_card',
      'detail_method_has_parentheses',
      'detail_method_has_square_brackets',
      'detail_method_has_hyphen',
      'detail_method_has_slash',
      'detail_method_has_whitespace',
      'detail_method_has_digits'
    ])
  })

  it('does not output names, account numbers, amounts or unknown method substrings', () => {
    const value = 'SYNTHETIC_PRIVATE_NAME 신용계정=91827364509 금액=735826원 UNKNOWN_METHOD'
    const flags = lotteMethodDiagnostics(value)
    expect(flags).toEqual([
      `detail_method_length_${value.length}`,
      'detail_method_token_credit',
      'detail_method_has_whitespace',
      'detail_method_has_digits'
    ])
    const encoded = JSON.stringify(flags)
    for (const privatePart of [
      'SYNTHETIC_PRIVATE_NAME',
      '91827364509',
      '735826',
      'UNKNOWN_METHOD',
      '계정',
      '금액'
    ])
      expect(encoded).not.toContain(privatePart)
  })

  it('caps length and does not process oversized input', () => {
    expect(lotteMethodDiagnostics('신용'.repeat(51))).toEqual([
      'detail_method_length_100',
      'detail_method_length_capped'
    ])
    expect(lotteMethodDiagnostics('x'.repeat(100))).toEqual(['detail_method_length_100'])
    expect(lotteMethodDiagnostics('')).toEqual(['detail_method_length_0'])
  })

  it('does not stringify or inspect non-string values', () => {
    const dangerous = {
      toString: (): never => {
        throw new Error('must not read')
      }
    }
    for (const value of [undefined, null, 91827364509, dangerous, ['신용']])
      expect(lotteMethodDiagnostics(value)).toEqual(['detail_method_input_unavailable'])
  })

  it('provides each approved public vocabulary flag without echoing its source word', () => {
    const flags = lotteMethodDiagnostics(
      '신용 체크 카드 일시불 할부 승인 거래 매입 취소 선불 후불 법인 개인 일반 국내 해외 포인트 체크카드 현금 서비스 단기 대출'
    )
    expect(flags.filter((flag) => flag.startsWith('detail_method_token_'))).toHaveLength(22)
    expect(flags).toContain('detail_method_token_short_term')
    expect(flags).toContain('detail_method_token_loan')
    expect(flags.every((flag) => /^detail_method_[a-z_]+(?:\d+)?$/.test(flag))).toBe(true)
  })
})
