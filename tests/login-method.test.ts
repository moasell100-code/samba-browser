import { describe, expect, it } from 'vitest'
import {
  LOGIN_METHOD_FIELD_KEY,
  LOGIN_METHODS,
  isHyundaiCardHost,
  isValidHyundaiPin,
  loginMethodOfSections,
  normalizeLoginMethod
} from '../src/shared/login-method'
import ko from '../src/renderer/src/i18n/ko.json'
import en from '../src/renderer/src/i18n/en.json'

describe('login method metadata', () => {
  it('defaults existing and unknown login methods to password', () => {
    expect(normalizeLoginMethod(undefined)).toBe('password')
    expect(normalizeLoginMethod('unknown')).toBe('password')
    expect(loginMethodOfSections([])).toBe('password')
    expect(loginMethodOfSections([{ key: 'main', fields: [] }])).toBe('password')
  })

  it('reads only public method metadata from the main section', () => {
    const field = { key: LOGIN_METHOD_FIELD_KEY, kind: 'select', value: 'hyundai_pin' }
    expect(loginMethodOfSections([{ key: 'main', fields: [field] }])).toBe('hyundai_pin')
    expect(loginMethodOfSections([{ key: 'custom', fields: [field] }])).toBe('password')
    expect(loginMethodOfSections([{ key: 'main', fields: [{ ...field, kind: 'secret' }] }])).toBe(
      'password'
    )
  })

  it('supports only exact Hyundai account hosts', () => {
    for (const host of ['hyundaicard.com', 'www.hyundaicard.com', ' WWW.HYUNDAICARD.COM ']) {
      expect(isHyundaiCardHost(host)).toBe(true)
    }
    for (const host of [
      'm.hyundaicard.com',
      'hyundaicard.com.evil.test',
      'evilhyundaicard.com',
      'hyundaicard.com@evil.test',
      'https://hyundaicard.com',
      ''
    ]) {
      expect(isHyundaiCardHost(host)).toBe(false)
    }
  })

  it('requires exactly six ASCII digits without trimming or truncating', () => {
    expect(isValidHyundaiPin('012345')).toBe(true)
    for (const value of ['', '12345', '1234567', '12a456', ' 123456', '123456\n', '１２３４５６']) {
      expect(isValidHyundaiPin(value)).toBe(false)
    }
  })

  it('has Korean and English labels for every method', () => {
    for (const locale of [ko, en]) {
      for (const method of LOGIN_METHODS) expect(locale.vault.loginMethod[method]).toBeTruthy()
      expect(locale.vault.fieldNames.hyundaiPin).toBeTruthy()
      expect(locale.vault.editor.hyundaiPinInvalid).toBeTruthy()
    }
  })
})
