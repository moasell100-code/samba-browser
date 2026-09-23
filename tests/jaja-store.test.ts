import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backendOrigin, JajaStore, type SecretCipher } from '../src/main/jaja/store'

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, renameSync: vi.fn(fs.renameSync) }
})

const KEY = 'a'.repeat(64)
const OTHER_KEY = 'b'.repeat(64)
const ID = '11111111-1111-4111-8111-111111111111'
const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  // Synthetic reversible test cipher only; runtime uses Electron safeStorage.
  encryptString: (value) => Buffer.from(`synthetic:${value.split('').reverse().join('')}`),
  decryptString: (value) => value.toString().slice('synthetic:'.length).split('').reverse().join('')
}
let directory: string
let file: string

beforeEach(() => {
  vi.mocked(renameSync).mockClear()
  directory = mkdtempSync(join(tmpdir(), 'jaja-store-test-'))
  file = join(directory, 'connection.json')
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('JAJA local connection storage', () => {
  it('preserves host and account partition identifiers across restart and same-origin pairing', () => {
    const store = new JajaStore(file, cipher)
    const sessionId = store.sessionId('sa_a')
    store.connect('https://api.ja-ja.org', KEY)
    const restarted = new JajaStore(file, cipher)
    expect(restarted.hostId).toBe(store.hostId)
    expect(restarted.sessionId('sa_a')).toBe(sessionId)
    expect(restarted.key()).toBe(KEY)
    restarted.connect('https://api.ja-ja.org', OTHER_KEY)
    expect(restarted.sessionId('sa_a')).toBe(sessionId)
  })

  it('stores only the cipher output and keeps sessions while disconnecting', () => {
    const store = new JajaStore(file, cipher)
    store.rememberSession('sa_a', ID)
    store.connect('https://api.ja-ja.org', KEY)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(Object.keys(saved)).not.toContain('key')
    expect(saved.keyCiphertext).toBe(cipher.encryptString(KEY).toString('base64'))
    store.disconnect()
    expect(store.key()).toBeNull()
    expect(store.sessionId('sa_a')).toBe(ID)
    expect(new JajaStore(file, cipher).key()).toBeNull()
  })

  it.each([
    '{broken',
    'null',
    '[]',
    '"string"',
    '{"hostId":5}',
    '{"sessionIds":{"sa_a":5}}',
    '{"backendOrigin":"https://outside.example"}'
  ])('preserves an invalid original file: %s', (original) => {
    writeFileSync(file, original)
    expect(() => new JajaStore(file, cipher)).toThrow()
    expect(readFileSync(file, 'utf8')).toBe(original)
    expect(renameSync).not.toHaveBeenCalled()
  })

  it('retains both in-memory and persisted key if disconnect cannot save', () => {
    const store = new JajaStore(file, cipher)
    store.connect('https://api.ja-ja.org', KEY)
    const before = readFileSync(file, 'utf8')
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error('private filesystem detail')
    })
    expect(() => store.disconnect()).toThrow('기존 연결 설정은 유지')
    expect(store.key()).toBe(KEY)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('retains the old backend, key and bindings when replacement pairing cannot save', () => {
    const store = new JajaStore(file, cipher)
    store.connect('https://api.ja-ja.org', KEY)
    store.rememberSession('sa_a', ID)
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error('private filesystem detail')
    })
    expect(() => store.connect('http://localhost:8000', OTHER_KEY)).toThrow('저장하지 못했습니다')
    expect(store.origin).toBe('https://api.ja-ja.org')
    expect(store.key()).toBe(KEY)
    expect(store.sessionId('sa_a')).toBe(ID)
  })

  it('retains the old session mapping when a mapping write fails', () => {
    const store = new JajaStore(file, cipher)
    store.rememberSession('sa_a', ID)
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error('private filesystem detail')
    })
    expect(() => store.rememberSession('sa_a', '22222222-2222-4222-8222-222222222222')).toThrow()
    expect(store.sessionId('sa_a')).toBe(ID)
  })

  it('handles dictionary prototype names as ordinary account identifiers', () => {
    const store = new JajaStore(file, cipher)
    expect(store.sessionId('__proto__')).toMatch(/^[a-f0-9-]{36}$/)
    expect(store.sessionId('constructor')).toMatch(/^[a-f0-9-]{36}$/)
  })

  it('does not save a connection when encryption is unavailable', () => {
    const store = new JajaStore(file, { ...cipher, isEncryptionAvailable: () => false })
    const before = readFileSync(file, 'utf8')
    expect(() => store.connect('https://api.ja-ja.org', KEY)).toThrow('안전하게 저장')
    expect(store.key()).toBeNull()
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it.each([
    'https://outside.example',
    'https://api.ja-ja.org/path',
    'https://name:password@api.ja-ja.org',
    'https://api.ja-ja.org?key=secret',
    'file:///local'
  ])('rejects a noncanonical backend: %s', (url) => {
    expect(() => backendOrigin(url)).toThrow()
  })
})
