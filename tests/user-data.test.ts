import { describe, expect, it } from 'vitest'
import { browserUserDataPath } from '../src/main/user-data'

describe('browser user data selection', () => {
  it('uses the shortcut profile for ordinary Windows development launches', () => {
    expect(
      browserUserDataPath({
        platform: 'win32',
        isPackaged: false,
        localAppData: 'C:\\Users\\Test User\\AppData\\Local'
      })
    ).toBe('C:\\Users\\Test User\\AppData\\Local\\JAJA-Samba-Browser')
  })

  it.each([
    { platform: 'win32' as const, isPackaged: false },
    { platform: 'win32' as const, isPackaged: true },
    { platform: 'linux' as const, isPackaged: false }
  ])('preserves an explicit profile override: %j', (mode) => {
    const override = 'D:\\isolated-profile'
    expect(browserUserDataPath({ ...mode, override })).toBe(override)
  })

  it.each([
    { platform: 'win32' as const, isPackaged: true },
    { platform: 'darwin' as const, isPackaged: false },
    { platform: 'linux' as const, isPackaged: false }
  ])('keeps the default profile policy outside Windows development: %j', (mode) => {
    expect(browserUserDataPath(mode)).toBeUndefined()
  })

  it.each([undefined, '', 'relative-profile'])(
    'does not open a different empty profile when LocalAppData is invalid: %s',
    (localAppData) => {
      expect(() =>
        browserUserDataPath({ platform: 'win32', isPackaged: false, localAppData })
      ).toThrow('local application data directory is unavailable')
    }
  )
})
