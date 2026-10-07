import { describe, expect, it } from 'vitest'
import { browserUserDataPath } from '../src/main/user-data'

describe('browser user data selection', () => {
  it.each([
    ['C:\\Users\\Test User', 'C:\\Users\\Test User\\.jaja-browser'],
    ['D:/Users/Test/', 'D:\\Users\\Test\\.jaja-browser'],
    ['\\\\server\\homes\\Test', '\\\\server\\homes\\Test\\.jaja-browser']
  ])('uses the user home outside AppData: %s', (userProfile, expected) => {
    for (const isPackaged of [false, true]) {
      expect(browserUserDataPath({ platform: 'win32', isPackaged, userProfile })).toBe(expected)
    }
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
    { platform: 'darwin' as const, isPackaged: false },
    { platform: 'darwin' as const, isPackaged: true },
    { platform: 'linux' as const, isPackaged: false },
    { platform: 'linux' as const, isPackaged: true }
  ])('keeps the default profile policy outside Windows: %j', (mode) => {
    expect(browserUserDataPath(mode)).toBeUndefined()
  })

  it.each([
    undefined,
    '',
    '  ',
    'relative-profile',
    'C:relative',
    '\\Users\\Test',
    '/Users/Test',
    '\\\\server'
  ])('fails closed when the Windows home is not fully absolute: %s', (userProfile) => {
    for (const isPackaged of [false, true]) {
      expect(() => browserUserDataPath({ platform: 'win32', isPackaged, userProfile })).toThrow(
        'absolute Windows user home directory is unavailable'
      )
    }
  })
})
