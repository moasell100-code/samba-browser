// Public login metadata. The credential stays in the login item's encrypted `value` field.
export type LoginMethod = 'password' | 'hyundai_pin'

export const LOGIN_METHOD_FIELD_KEY = 'login.method'
export const LOGIN_METHODS: readonly LoginMethod[] = ['password', 'hyundai_pin']
export const DEFAULT_LOGIN_METHOD: LoginMethod = 'password'

export function normalizeLoginMethod(raw: string | null | undefined): LoginMethod {
  return raw === 'hyundai_pin' ? 'hyundai_pin' : DEFAULT_LOGIN_METHOD
}

interface LoginMethodSection {
  key: string
  fields: readonly { key: string; kind?: string; value?: string }[]
}

/** Old entries without public method metadata retain ordinary password login. */
export function loginMethodOfSections(sections: readonly LoginMethodSection[]): LoginMethod {
  const field = sections
    .find((section) => section.key === 'main')
    ?.fields.find((candidate) => candidate.key === LOGIN_METHOD_FIELD_KEY)
  return field?.kind === 'secret' ? DEFAULT_LOGIN_METHOD : normalizeLoginMethod(field?.value)
}

/** Only these exact account hosts support Hyundai Card's registered simple PIN. */
export function isHyundaiCardHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  return normalized === 'hyundaicard.com' || normalized === 'www.hyundaicard.com'
}

export function isValidHyundaiPin(value: string): boolean {
  return value.length === 6 && /^[0-9]{6}$/.test(value)
}
