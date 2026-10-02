const WORDS = [
  ['신용', 'credit'],
  ['체크', 'debit'],
  ['카드', 'card'],
  ['일시불', 'single_payment'],
  ['할부', 'installment'],
  ['승인', 'approval'],
  ['거래', 'transaction'],
  ['매입', 'purchase'],
  ['취소', 'cancellation'],
  ['선불', 'prepaid'],
  ['후불', 'postpaid'],
  ['법인', 'corporate'],
  ['개인', 'personal'],
  ['일반', 'general'],
  ['국내', 'domestic'],
  ['해외', 'overseas'],
  ['포인트', 'points'],
  ['체크카드', 'debit_card'],
  ['현금', 'cash'],
  ['서비스', 'service'],
  ['단기', 'short_term'],
  ['대출', 'loan']
] as const

const SYNTAX = [
  [/[()]/, 'parentheses'],
  [/\[|\]/, 'square_brackets'],
  [/-/, 'hyphen'],
  [/\//, 'slash'],
  [/\s/, 'whitespace'],
  [/\d/, 'digits']
] as const

/** Public vocabulary and bounded shape only; never return input text, substrings or numeric values. */
export function lotteMethodDiagnostics(value: unknown): string[] {
  if (typeof value !== 'string') return ['detail_method_input_unavailable']
  const flags = [`detail_method_length_${Math.min(value.length, 100)}`]
  if (value.length > 100) return [...flags, 'detail_method_length_capped']
  for (const [word, code] of WORDS)
    if (value.includes(word)) flags.push(`detail_method_token_${code}`)
  for (const [pattern, code] of SYNTAX)
    if (pattern.test(value)) flags.push(`detail_method_has_${code}`)
  return flags
}
