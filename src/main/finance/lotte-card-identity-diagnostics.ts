const PUBLIC_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,40}$/
const CARD_FIELD = /card|cdno|no/i

/** JSON schema names and card-shape booleans only. No response field values leave this helper. */
export function lotteCardIdentityDiagnostics(response: unknown): string[] {
  if (!response || typeof response !== 'object' || Array.isArray(response))
    return ['detail_param_unavailable']
  const param: unknown = Object.getOwnPropertyDescriptor(response, 'Param')?.value
  if (!param || typeof param !== 'object' || Array.isArray(param))
    return ['detail_param_unavailable']
  const prototype: unknown = Object.getPrototypeOf(param)
  if (prototype !== Object.prototype && prototype !== null) return ['detail_param_unavailable']
  const entries = Object.entries(Object.getOwnPropertyDescriptors(param))
  if (entries.length > 80) return ['detail_param_field_limit']
  const flags: string[] = []
  for (const [key, descriptor] of entries) {
    if (!PUBLIC_FIELD.test(key) || /\d{8}/.test(key) || !Object.hasOwn(descriptor, 'value'))
      continue
    flags.push(`detail_param_field_${key}`)
    const value: unknown = descriptor.value
    if (
      CARD_FIELD.test(key) &&
      typeof value === 'string' &&
      value.length >= 14 &&
      value.length <= 30 &&
      /^[\d* -]+$/.test(value)
    )
      flags.push(`detail_param_card_format_${key}`)
  }
  return flags
}
