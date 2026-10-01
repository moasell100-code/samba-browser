import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export interface HyundaiAttempt {
  accountId: number
  itemId: number
  /** Opaque revision of the encrypted login credential, never the PIN or its hash. */
  revision: string
  profile: string
}

export interface HyundaiAttempts {
  begin(attempt: HyundaiAttempt): boolean
  failed(attempt: HyundaiAttempt): void
  succeeded(attempt: HyundaiAttempt): void
  clearSignedInProfile(profile: string): void
}

interface AttemptRecord {
  revision: string
  profile: string
  state: 'pending' | 'failed'
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const activeAttempts = new Set<string>()

/** Persist before the first digit: task cancellation, crashes and app restarts cannot retry a PIN. */
export class HyundaiAttemptStore implements HyundaiAttempts {
  constructor(private readonly directory: string) {}

  private path(attempt: HyundaiAttempt): string {
    return join(this.directory, `${digest(`${attempt.accountId}:${attempt.itemId}`)}.json`)
  }

  private read(path: string): AttemptRecord {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!value || typeof value !== 'object') throw new Error('invalid attempt record')
    const row = value as Partial<AttemptRecord>
    if (
      typeof row.revision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.revision) ||
      typeof row.profile !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.profile) ||
      (row.state !== 'pending' && row.state !== 'failed')
    )
      throw new Error('invalid attempt record')
    return row as AttemptRecord
  }

  begin(attempt: HyundaiAttempt): boolean {
    if (!attempt.revision) return false
    mkdirSync(this.directory, { recursive: true })
    const path = this.path(attempt)
    if (activeAttempts.has(path)) return false
    const revision = digest(attempt.revision)
    const data: AttemptRecord = { revision, profile: digest(attempt.profile), state: 'pending' }
    if (existsSync(path)) {
      const previous = this.read(path)
      if (previous.revision === revision) return false
      const temporary = `${path}.tmp`
      writeFileSync(temporary, JSON.stringify(data), { flag: 'w', mode: 0o600, flush: true })
      renameSync(temporary, path)
    } else {
      try {
        writeFileSync(path, JSON.stringify(data), { flag: 'wx', mode: 0o600, flush: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw error
      }
    }
    activeAttempts.add(path)
    return true
  }

  failed(attempt: HyundaiAttempt): void {
    const path = this.path(attempt)
    activeAttempts.delete(path)
    const row = this.read(path)
    if (row.revision !== digest(attempt.revision)) return
    writeFileSync(path, JSON.stringify({ ...row, state: 'failed' }), { mode: 0o600, flush: true })
  }

  succeeded(attempt: HyundaiAttempt): void {
    const path = this.path(attempt)
    activeAttempts.delete(path)
    if (existsSync(path) && this.read(path).revision === digest(attempt.revision)) unlinkSync(path)
  }

  clearSignedInProfile(profile: string): void {
    if (!existsSync(this.directory)) return
    for (const filename of readdirSync(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(filename)) continue
      const path = join(this.directory, filename)
      // Corrupt records remain blocked; they are never interpreted as a fresh attempt.
      try {
        if (this.read(path).profile === digest(profile)) unlinkSync(path)
      } catch {
        /* retain the latch */
      }
    }
  }
}

let defaultStore: HyundaiAttemptStore | undefined
export function hyundaiAttempts(): HyundaiAttempts {
  // Lazy: tests and non-Hyundai logins must not touch the filesystem or Electron userData.
  const userData = app.getPath('userData')
  if (!userData) throw new Error('Hyundai attempt storage unavailable')
  return (defaultStore ??= new HyundaiAttemptStore(join(userData, 'hyundai-login-attempts')))
}
