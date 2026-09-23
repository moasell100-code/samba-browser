import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JajaClient, JajaApiError } from '../src/main/jaja/client'
import { backendOrigin, JajaStore } from '../src/main/jaja/store'
import type { JajaSession } from '../src/shared/jaja'

const directories: string[] = []
const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from([...value].reverse().join('')),
  decryptString: (value: Buffer) => [...value.toString()].reverse().join('')
}
const key = '0123456789abcdef'.repeat(4)
const remote: JajaSession = {
  sessionId: '12345678-1234-1234-1234-123456789abc',
  accountId: 'a',
  site: 'MUSINSA',
  hostId: 'host',
  state: 'observe',
  revision: 7,
  identityState: 'verified',
  providerSessionId: null,
  syncSupported: true
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function store(): { value: JajaStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'jaja-store-test-'))
  directories.push(dir)
  const file = join(dir, 'connection.json')
  return { value: new JajaStore(file, cipher), file }
}

describe('JAJA local connection storage', () => {
  it('persists encrypted API key, stable host and per-account session IDs across restart', () => {
    const { value, file } = store()
    const a = value.sessionId('a')
    expect(value.sessionId('b')).not.toBe(a)
    value.connect('https://api.ja-ja.org', key)
    expect(readFileSync(file, 'utf8')).not.toContain(key)
    const restarted = new JajaStore(file, cipher)
    expect(restarted.key()).toBe(key)
    expect(restarted.hostId).toBe(value.hostId)
    expect(restarted.sessionId('a')).toBe(a)
    restarted.disconnect()
    expect(restarted.key()).toBeNull()
    expect(restarted.sessionId('a')).toBe(a)
    expect(readFileSync(file, 'utf8')).not.toContain('keyCiphertext')
  })
  it('fails closed when OS encryption is unavailable', () => {
    const { file } = store()
    const value = new JajaStore(file, { ...cipher, isEncryptionAvailable: () => false })
    expect(() => value.connect('https://api.ja-ja.org', key)).toThrow('안전하게')
    expect(value.key()).toBeNull()
  })
  it.each([
    'https://api.ja-ja.org.evil.test',
    'http://api.ja-ja.org',
    'https://api.ja-ja.org/private',
    'https://api.ja-ja.org?key=x',
    'https://user:pass@api.ja-ja.org',
    'https://evil.test',
    'file:///C:/test',
    'http://192.168.0.2:8000'
  ])('rejects untrusted backend %s', (url) => {
    expect(() => backendOrigin(url)).toThrow()
  })
  it.each(['https://api.ja-ja.org', 'http://localhost:8000', 'http://127.0.0.1:8181'])(
    'allows %s',
    (url) => {
      expect(backendOrigin(url)).toBe(url)
    }
  )
})

describe('JAJA browser API transport', () => {
  it('uses bound host key, forbids redirects, sends current CAS revision in observe mode', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 200 }))
    const client = new JajaClient('http://localhost:8000', 'host', () => key, fetcher)
    await client.cookies(remote, 'synthetic=only', { source: 'jar' })
    const [url, options] = fetcher.mock.calls[0]
    expect(url).toBe(
      `http://localhost:8000/api/v1/samba/browser/sessions/${remote.sessionId}/cookies`
    )
    expect(options.redirect).toBe('error')
    expect(options.headers['X-Device-Id']).toBe('host')
    expect(options.headers['X-Api-Key']).toBe(key)
    expect(JSON.parse(options.body)).toEqual({
      cookie: 'synthetic=only',
      extra: { source: 'jar' },
      mode: 'observe',
      revision: 7
    })
  })
  it('activates against the previous provider the user reviewed', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}'))
    const client = new JajaClient('http://localhost:8000', 'host', () => key, fetcher)
    await client.activate({ ...remote, providerSessionId: 'previous' })
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      expectedPreviousOwner: 'previous',
      revision: 7
    })
  })
  it('does not expose response bodies or raw transport exceptions', async () => {
    const secret = 'synthetic-secret-in-server-response'
    const fetcher = vi.fn().mockResolvedValue(new Response(secret, { status: 409 }))
    const client = new JajaClient('http://localhost:8000', 'host', () => key, fetcher)
    await expect(client.accounts()).rejects.toBeInstanceOf(JajaApiError)
    fetcher.mockRejectedValue(new Error(secret))
    await expect(client.accounts()).rejects.not.toThrow(secret)
    await expect(client.accounts()).rejects.toThrow('로그인 만료로 판정하지 않았습니다')
  })
  it('does not call the server without a connection key', async () => {
    const fetcher = vi.fn()
    const client = new JajaClient('http://localhost:8000', 'host', () => null, fetcher)
    await expect(client.accounts()).rejects.toThrow('연결이 필요')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
