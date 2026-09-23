import { basename, join, resolve } from 'node:path'
import type { App, Session } from 'electron'

export const VALIDATION_BACKEND = 'http://127.0.0.1:18300'
export const VALIDATION_FRONTEND = 'http://localhost:18301'
export const VALIDATION_PROFILE = 'JAJA-Browser-Validation'

// These real-looking origins are permitted only after a session has a local,
// fail-closed HTTPS protocol handler. They must never resolve over the network.
export const VALIDATION_MOCK_ORIGINS = new Set([
  'https://www.musinsa.com',
  'https://api.musinsa.com',
  'https://order.musinsa.com',
  'https://goods.musinsa.com',
  'https://my.musinsa.com',
  'https://www.29cm.co.kr',
  'https://user-api.29cm.co.kr',
  'https://www.lotteon.com',
  'https://abcmart.a-rt.com'
])

export function isJajaValidation(): boolean {
  return process.env.JAJA_VALIDATION === '1'
}

export function validationUserData(
  localAppData: string,
  override: string | undefined,
  originalUserData: string
): string {
  const target = resolve(override || join(localAppData, VALIDATION_PROFILE))
  if (
    basename(target) !== VALIDATION_PROFILE ||
    target.toLowerCase() === resolve(originalUserData).toLowerCase()
  ) {
    throw new Error('검증 전용 프로필만 사용할 수 있습니다. 기존 브라우저는 변경하지 않았습니다.')
  }
  return target
}

export function configureValidationProfile(app: Pick<App, 'getPath' | 'setPath'>): void {
  if (!isJajaValidation()) return
  const target = validationUserData(
    process.env.LOCALAPPDATA || app.getPath('appData'),
    process.env.SAMBA_USER_DATA,
    app.getPath('userData')
  )
  app.setPath('userData', target)
}

export function validationRequestAllowed(url: string, mockHandlerInstalled = false): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.username || parsed.password) return false
    if (['file:', 'about:', 'data:', 'blob:', 'samba:', 'devtools:'].includes(parsed.protocol))
      return true
    if (parsed.origin === VALIDATION_BACKEND || parsed.origin === VALIDATION_FRONTEND) return true
    return mockHandlerInstalled && VALIDATION_MOCK_ORIGINS.has(parsed.origin)
  } catch {
    return false
  }
}

const guarded = new WeakSet<Session>()
const mockSessions = new WeakSet<Session>()

/** Call only after installing a fail-closed local HTTPS protocol handler. */
export function enableValidationMockSites(browser: Session): void {
  if (!isJajaValidation()) throw new Error('검증 모드에서만 합성 사이트를 사용할 수 있습니다.')
  if (!guarded.has(browser)) throw new Error('검증 네트워크 차단이 먼저 적용되어야 합니다.')
  mockSessions.add(browser)
}

export function guardValidationSession(browser: Session): void {
  if (!isJajaValidation() || guarded.has(browser)) return
  browser.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !validationRequestAllowed(details.url, mockSessions.has(browser)) })
  })
  guarded.add(browser)
}

export function registerValidationNetwork(app: Pick<App, 'on' | 'commandLine'>): void {
  if (!isJajaValidation()) return
  // A missing or accidentally removed synthetic protocol handler must fail DNS
  // resolution instead of reaching the similarly named real shopping site.
  app.commandLine.appendSwitch(
    'host-resolver-rules',
    'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'
  )
  app.on('session-created', guardValidationSession)
}
