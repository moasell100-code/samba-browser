import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const JAJA_BACKEND = 'https://api.ja-ja.org'
export const JAJA_WEB = 'https://app.ja-ja.org'

export function backendOrigin(value: string): string {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('자자 서버의 기본 주소를 입력하세요.')
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.origin !== JAJA_BACKEND && !(local && url.protocol === 'http:')) {
    throw new Error('자자 서버 또는 로컬 개발 서버만 연결할 수 있습니다.')
  }
  return url.origin
}

export function frontendOrigin(backend: string): string {
  return backend === JAJA_BACKEND ? JAJA_WEB : 'http://localhost:3000'
}

export interface SecretCipher {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

interface SavedConnection {
  version: 1
  hostId: string
  backendOrigin: string
  keyCiphertext?: string
  sessionIds: Record<string, string>
  autoLogin: Record<string, boolean>
}

const INVALID_SETTINGS = '자자 연결 설정을 읽지 못했습니다. 원본 설정 파일을 확인하세요.'
const SAVE_FAILED = '자자 연결 설정을 저장하지 못했습니다. 기존 연결 설정은 유지됩니다.'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readSaved(value: unknown): Partial<SavedConnection> {
  if (!record(value)) throw new Error(INVALID_SETTINGS)
  if (
    (value.version !== undefined && value.version !== 1) ||
    (value.hostId !== undefined &&
      (typeof value.hostId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.hostId))) ||
    (value.backendOrigin !== undefined && typeof value.backendOrigin !== 'string') ||
    (value.keyCiphertext !== undefined && typeof value.keyCiphertext !== 'string') ||
    (value.sessionIds !== undefined &&
      (!record(value.sessionIds) ||
        Object.values(value.sessionIds).some(
          (id) => typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)
        ))) ||
    (value.autoLogin !== undefined &&
      (!record(value.autoLogin) ||
        Object.values(value.autoLogin).some((enabled) => typeof enabled !== 'boolean')))
  ) {
    throw new Error(INVALID_SETTINGS)
  }
  return value as Partial<SavedConnection>
}

export class JajaStore {
  private value: SavedConnection

  constructor(
    private file: string,
    private cipher: SecretCipher
  ) {
    let saved: Partial<SavedConnection> = {}
    if (existsSync(file)) {
      try {
        saved = readSaved(JSON.parse(readFileSync(file, 'utf8')))
      } catch {
        throw new Error(INVALID_SETTINGS)
      }
    }
    this.value = {
      version: 1,
      hostId: saved.hostId || `jaja-browser-${randomUUID()}`,
      backendOrigin: backendOrigin(saved.backendOrigin || JAJA_BACKEND),
      sessionIds: { ...saved.sessionIds },
      autoLogin: { ...saved.autoLogin },
      ...(saved.keyCiphertext ? { keyCiphertext: saved.keyCiphertext } : {})
    }
    this.save(this.value)
  }

  get hostId(): string {
    return this.value.hostId
  }
  get origin(): string {
    return this.value.backendOrigin
  }

  key(): string | null {
    if (!this.value.keyCiphertext) return null
    if (!this.cipher.isEncryptionAvailable())
      throw new Error('Windows의 안전한 키 저장소를 사용할 수 없습니다.')
    try {
      const key = this.cipher.decryptString(Buffer.from(this.value.keyCiphertext, 'base64'))
      if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('invalid_key')
      return key
    } catch {
      throw new Error('이 PC에서 연결 키를 열 수 없습니다. 자자에 다시 연결하세요.')
    }
  }

  connect(origin: string, key: string): void {
    const normalized = backendOrigin(origin)
    if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('자자 연결 키 형식이 올바르지 않습니다.')
    if (!this.cipher.isEncryptionAvailable())
      throw new Error('연결 키를 안전하게 저장할 수 없습니다.')
    const next: SavedConnection = {
      ...this.value,
      backendOrigin: normalized,
      keyCiphertext: this.cipher.encryptString(key).toString('base64'),
      sessionIds: normalized === this.value.backendOrigin ? this.value.sessionIds : {},
      autoLogin: {}
    }
    this.save(next)
  }

  disconnect(): void {
    const next = { ...this.value, autoLogin: {} }
    delete next.keyCiphertext
    this.save(next)
  }

  sessionId(accountId: string): string {
    if (!Object.hasOwn(this.value.sessionIds, accountId)) {
      this.rememberSession(accountId, randomUUID())
    }
    return this.value.sessionIds[accountId]
  }

  rememberSession(accountId: string, id: string): void {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('브라우저 세션 식별자가 올바르지 않습니다.')
    this.save({ ...this.value, sessionIds: { ...this.value.sessionIds, [accountId]: id } })
  }

  autoLogin(accountId: string): boolean {
    return (
      Object.hasOwn(this.value.autoLogin, accountId) && this.value.autoLogin[accountId] === true
    )
  }
  setAutoLogin(accountId: string, enabled: boolean): void {
    this.save({ ...this.value, autoLogin: { ...this.value.autoLogin, [accountId]: enabled } })
  }

  private save(next: SavedConnection): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.tmp`
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 })
      renameSync(temporary, this.file)
    } catch {
      throw new Error(SAVE_FAILED)
    }
    // Publish only after the atomic rename: failed writes must leave the usable key intact.
    this.value = next
  }
}
