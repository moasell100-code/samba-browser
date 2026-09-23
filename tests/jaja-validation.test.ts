import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Session } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JajaClient } from '../src/main/jaja/client'
import { backendOrigin, frontendOrigin, JajaStore } from '../src/main/jaja/store'
import {
  enableValidationMockSites,
  guardValidationSession,
  validationRequestAllowed,
  validationUserData,
  VALIDATION_BACKEND,
  VALIDATION_FRONTEND
} from '../src/main/jaja/validation'

const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => value.toString()
}
let directory: string

beforeEach(() => {
  vi.stubEnv('JAJA_VALIDATION', '1')
  directory = mkdtempSync(join(tmpdir(), 'jaja-validation-test-'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

describe('isolated validation environment', () => {
  it('uses a dedicated profile and refuses normal or reused profile paths', () => {
    const normal = join(directory, 'JAJA-Samba-Browser')
    expect(validationUserData(directory, undefined, normal)).toBe(
      resolve(directory, 'JAJA-Browser-Validation')
    )
    expect(() => validationUserData(directory, normal, normal)).toThrow('검증 전용')
    const validation = join(directory, 'JAJA-Browser-Validation')
    expect(() => validationUserData(directory, validation, validation)).toThrow('검증 전용')
  })

  it('defaults to the separate backend and pairing frontend', () => {
    const store = new JajaStore(join(directory, 'connection.json'), cipher)
    expect(store.origin).toBe(VALIDATION_BACKEND)
    expect(frontendOrigin(store.origin)).toBe(VALIDATION_FRONTEND)
    expect(store.key()).toBeNull()
  })

  it('refuses a saved production connection without altering or decrypting it', () => {
    const file = join(directory, 'connection.json')
    const original = JSON.stringify({
      version: 1,
      hostId: 'synthetic-old-profile',
      backendOrigin: 'https://api.ja-ja.org',
      keyCiphertext: 'synthetic-encrypted-placeholder',
      sessionIds: {},
      autoLogin: {}
    })
    writeFileSync(file, original)
    const decryptString = vi.fn(cipher.decryptString)
    expect(() => new JajaStore(file, { ...cipher, decryptString })).toThrow('운영 서버는 차단')
    expect(readFileSync(file, 'utf8')).toBe(original)
    expect(decryptString).not.toHaveBeenCalled()
  })

  it.each([
    'https://api.ja-ja.org',
    'http://localhost:8000',
    'http://127.0.0.1:18301',
    'http://localhost:18300',
    'http://127.0.0.1:18300/path',
    'http://user:password@127.0.0.1:18300',
    'http://127.0.0.1:18300?next=https://api.ja-ja.org'
  ])('blocks renderer or Node client connection to %s', (origin) => {
    expect(() => backendOrigin(origin)).toThrow()
    const fetcher = vi.fn()
    expect(() => new JajaClient(origin, 'synthetic-host', () => 'a'.repeat(64), fetcher)).toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('leaves ordinary browser mode endpoints unchanged', () => {
    vi.stubEnv('JAJA_VALIDATION', '0')
    expect(backendOrigin('https://api.ja-ja.org')).toBe('https://api.ja-ja.org')
    expect(frontendOrigin('https://api.ja-ja.org')).toBe('https://app.ja-ja.org')
    expect(frontendOrigin('http://localhost:8000')).toBe('http://localhost:3000')
  })
})

describe('validation session network boundary', () => {
  it.each([
    'https://api.ja-ja.org/api/v1/samba/browser/accounts',
    'https://app.ja-ja.org/samba/extension-link',
    'https://www.musinsa.com.evil.test/',
    'https://www.musinsa.com:444/',
    'http://www.musinsa.com/',
    'https://member.musinsa.com/',
    'https://accounts.google.com/',
    'http://localhost:3000/',
    'http://127.0.0.1:18301/',
    'ws://localhost:18301/',
    'ftp://outside.example/',
    'http://user:password@127.0.0.1:18300/'
  ])('blocks %s even with synthetic sites installed', (url) => {
    expect(validationRequestAllowed(url, true)).toBe(false)
  })

  it('allows only exact local endpoints and local renderer resources by default', () => {
    for (const url of [
      `${VALIDATION_BACKEND}/api/v1/samba/browser/accounts`,
      `${VALIDATION_FRONTEND}/samba/extension-link`,
      'samba://newtab',
      'file:///synthetic-renderer/index.html',
      'about:blank'
    ]) {
      expect(validationRequestAllowed(url)).toBe(true)
    }
    expect(validationRequestAllowed('https://www.musinsa.com')).toBe(false)
    expect(validationRequestAllowed('https://www.musinsa.com', true)).toBe(true)
  })

  it('keeps synthetic domains closed until their session handler is ready', () => {
    const onBeforeRequest = vi.fn()
    const browser = { webRequest: { onBeforeRequest } } as unknown as Session
    expect(() => enableValidationMockSites(browser)).toThrow('먼저')
    guardValidationSession(browser)
    guardValidationSession(browser)
    expect(onBeforeRequest).toHaveBeenCalledTimes(1)
    const listener = onBeforeRequest.mock.calls[0][0]
    const callback = vi.fn()
    listener({ url: 'https://www.musinsa.com' }, callback)
    expect(callback).toHaveBeenLastCalledWith({ cancel: true })
    enableValidationMockSites(browser)
    listener({ url: 'https://www.musinsa.com' }, callback)
    expect(callback).toHaveBeenLastCalledWith({ cancel: false })
    listener({ url: 'https://api.ja-ja.org' }, callback)
    expect(callback).toHaveBeenLastCalledWith({ cancel: true })
  })
})
