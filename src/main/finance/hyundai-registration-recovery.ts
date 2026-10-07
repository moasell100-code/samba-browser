import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { app, type Cookie, type CookiesSetDetails, type Session } from 'electron'
import initSqlJs from 'sql.js'
import type { Tab } from '../browser/tab-manager'
import { pageBridge } from '../browser/page-bridge'
import type { HyundaiAuthSnapshot } from '../../shared/hyundai-auth'
import { HYUNDAI_LOGIN_URL, isHyundaiLoginUrl } from './hyundai-login'

const BACKUP = ['.jaja-browser-backups', 'storage-unification-20261007', 'normal-profile']
const CHROME_EPOCH_SECONDS = 11_644_473_600
const MAX_BACKUP_BYTES = 4 * 1024 * 1024
const MAX_COOKIES = 100
const attemptedSessions = new WeakSet<Session>()
const SAME_SITE = ['unspecified', 'no_restriction', 'lax', 'strict'] as const
const COOKIE_NAME_SEPARATORS = new Set('()<>@,;:\\"/[]?={}'.split(''))
const invalidCookieName = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x20 || code === 0x7f || COOKIE_NAME_SEPARATORS.has(character)
  })
const invalidCookieValue = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })

type Issue =
  | 'unsupported_context'
  | 'backup_unavailable'
  | 'backup_schema_unverified'
  | 'encrypted_cookie_unsupported'
  | 'backup_scope_unverified'
  | 'no_retained_cookies'
  | 'cookie_conflict'
  | 'cookie_restore_failed'
  | 'navigation_changed'
  | 'authentication_unchanged'
  | 'cancelled'
  | 'timeout'
  | 'mutation_unsettled'
  | 'rollback_conflict'

export interface HyundaiRegistrationRecoveryResult {
  state:
    | 'restored'
    | 'already_signed_in'
    | 'registration_present'
    | 'blocked'
    | 'failed'
    | 'already_attempted'
  auth?: HyundaiAuthSnapshot['state']
  restoredCookies?: number
  issue?: Issue
}

class RecoveryError extends Error {
  constructor(readonly issue: Issue) {
    super(issue)
  }
}

const samePath = (left: string, right: string): boolean =>
  resolve(left).toLowerCase() === resolve(right).toLowerCase()
const cookieDomain = (domain?: string): string => (domain ?? '').replace(/^\./, '').toLowerCase()
const cookieUrl = (cookie: Pick<Cookie, 'domain'>): string =>
  `https://${cookieDomain(cookie.domain)}/`
const cookieIdentity = (cookie: Cookie): string =>
  JSON.stringify([cookie.name, cookieDomain(cookie.domain), !!cookie.hostOnly, cookie.path ?? '/'])
const sameCookie = (left: Cookie | undefined, right: Cookie | undefined): boolean =>
  (!left && !right) ||
  (!!left &&
    !!right &&
    cookieIdentity(left) === cookieIdentity(right) &&
    left.value === right.value &&
    !!left.secure === !!right.secure &&
    !!left.httpOnly === !!right.httpOnly &&
    left.sameSite === right.sameSite &&
    !!left.session === !!right.session &&
    (left.expirationDate === right.expirationDate ||
      (left.expirationDate !== undefined &&
        right.expirationDate !== undefined &&
        Math.abs(left.expirationDate - right.expirationDate) < 0.00001)))

function details(cookie: Cookie): CookiesSetDetails {
  return {
    url: cookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    path: cookie.path ?? '/',
    secure: !!cookie.secure,
    httpOnly: !!cookie.httpOnly,
    sameSite: cookie.sameSite,
    ...(cookie.session ? {} : { expirationDate: cookie.expirationDate })
  }
}

/** Reads the one retained SQLite snapshot entirely in memory; never opens or saves live DB files. */
async function retainedCookies(home: string): Promise<Cookie[]> {
  const source = join(home, ...BACKUP, 'Partitions', 'ws1-default', 'Network', 'Cookies')
  let bytes: Buffer
  try {
    bytes = await readFile(source)
  } catch {
    throw new RecoveryError('backup_unavailable')
  }
  const result: Cookie[] = []
  try {
    if (!bytes.length || bytes.length > MAX_BACKUP_BYTES)
      throw new RecoveryError('backup_schema_unverified')
    const SQL = await initSqlJs({ locateFile: (file) => require.resolve(`sql.js/dist/${file}`) })
    const db = new SQL.Database(bytes)
    try {
      if (String(db.exec("SELECT value FROM meta WHERE key='version'")[0]?.values[0]?.[0]) !== '24')
        throw new RecoveryError('backup_schema_unverified')
      const query = db.prepare(`SELECT host_key, name, value,
        length(CAST(name AS BLOB)) AS name_bytes, length(CAST(value AS BLOB)) AS value_bytes,
        encrypted_value, path, expires_utc,
        is_secure, is_httponly, is_persistent, samesite, top_frame_site_key FROM cookies
        WHERE host_key IN ('.hyundaicard.com', 'www.hyundaicard.com', 'hyundaicard.com')`)
      let count = 0
      try {
        while (query.step()) {
          if (++count > MAX_COOKIES) throw new RecoveryError('backup_scope_unverified')
          const row = query.getAsObject()
          const encrypted = row.encrypted_value
          // The inspected fixed backup uses plaintext values. Never guess an OSCrypt
          // key or add a DPAPI decrypt path if its actual format has changed.
          if (!(encrypted instanceof Uint8Array) || encrypted.length !== 0)
            throw new RecoveryError('encrypted_cookie_unsupported')
          const expires = row.expires_utc
          if (typeof expires !== 'number' || !Number.isFinite(expires) || expires < 0)
            throw new RecoveryError('backup_schema_unverified')
          const expirationDate = expires / 1_000_000 - CHROME_EPOCH_SECONDS
          if (expirationDate <= Date.now() / 1000) continue // Do not revive or extend expired cookies.
          if (
            typeof row.host_key !== 'string' ||
            !['.hyundaicard.com', 'www.hyundaicard.com', 'hyundaicard.com'].includes(
              row.host_key
            ) ||
            typeof row.name !== 'string' ||
            !row.name ||
            row.name.length > 256 ||
            row.name_bytes !== Buffer.byteLength(row.name, 'utf8') ||
            invalidCookieName(row.name) ||
            typeof row.value !== 'string' ||
            row.value.length > 4096 ||
            row.value_bytes !== Buffer.byteLength(row.value, 'utf8') ||
            invalidCookieValue(row.value) ||
            row.path !== '/' ||
            row.is_persistent !== 1 ||
            ![0, 1].includes(Number(row.is_secure)) ||
            ![0, 1].includes(Number(row.is_httponly)) ||
            typeof row.samesite !== 'number' ||
            ![-1, 0, 1, 2].includes(row.samesite) ||
            row.top_frame_site_key !== ''
          )
            throw new RecoveryError('backup_scope_unverified')
          result.push({
            name: row.name,
            value: row.value,
            domain: row.host_key,
            hostOnly: !row.host_key.startsWith('.'),
            path: '/',
            secure: row.is_secure === 1,
            httpOnly: row.is_httponly === 1,
            sameSite: SAME_SITE[row.samesite + 1],
            session: false,
            expirationDate
          })
        }
      } finally {
        query.free()
      }
      if (!result.length) throw new RecoveryError('no_retained_cookies')
      // cookies.remove accepts a URL/name, not a canonical cookie identity. Reject
      // ambiguous source names before writing rather than risking another scope in rollback.
      if (new Set(result.map((cookie) => cookie.name)).size !== result.length)
        throw new RecoveryError('backup_scope_unverified')
      return result
    } finally {
      db.close()
    }
  } catch (error) {
    result.length = 0
    throw error instanceof RecoveryError ? error : new RecoveryError('backup_schema_unverified')
  } finally {
    bytes.fill(0)
  }
}

/** One fixed, authorized registration-cookie recovery. No PIN entry or attempt-store reset. */
export async function recoverHyundaiRegistration(
  tab: Tab,
  signal?: AbortSignal
): Promise<HyundaiRegistrationRecoveryResult> {
  const home = homedir()
  const expectedUserData = join(home, '.jaja-browser')
  const expectedStorage = join(expectedUserData, 'Partitions', 'ws1-default')
  const wc = tab.view.webContents
  const session = wc.session
  const previous = new Map<string, Cookie | undefined>()
  const applied: Array<{
    candidate: Cookie
    written: Cookie
    original?: Cookie
    pending: Promise<void>
    settled: boolean
  }> = []
  let candidates: Cookie[] = []
  let auth: HyundaiAuthSnapshot['state'] = 'unknown'
  let navigating = false
  const initialUrl = wc.getURL()
  const stop = new AbortController()
  const timer = setTimeout(() => stop.abort(), 30_000)
  timer.unref?.()
  const combined = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal
  const context = (): void => {
    if (signal?.aborted) throw new RecoveryError('cancelled')
    if (stop.signal.aborted) throw new RecoveryError('timeout')
    if (
      wc.isDestroyed() ||
      tab.view.webContents !== wc ||
      wc.session !== session ||
      !isHyundaiLoginUrl(wc.getURL()) ||
      (!navigating && wc.getURL() !== initialUrl)
    )
      throw new RecoveryError('navigation_changed')
  }
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    context()
    let cancel: (() => void) | undefined
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          cancel = () => reject(new RecoveryError(signal?.aborted ? 'cancelled' : 'timeout'))
          combined.addEventListener('abort', cancel, { once: true })
          if (combined.aborted) cancel()
        })
      ])
    } finally {
      if (cancel) combined.removeEventListener('abort', cancel)
    }
  }
  const current = async (cookie: Cookie): Promise<Cookie | undefined> => {
    const matches = await session.cookies.get({ url: cookieUrl(cookie), name: cookie.name })
    const exact = matches.filter((item) => cookieIdentity(item) === cookieIdentity(cookie))
    if (matches.length > 1 || (!exact.length && matches.length))
      throw new RecoveryError('cookie_conflict')
    return exact[0] ? { ...exact[0] } : undefined
  }
  const rollback = async (
    entry: (typeof applied)[number],
    within: <T>(operation: () => Promise<T>) => Promise<T>
  ): Promise<boolean> => {
    const live = await within(() => current(entry.candidate))
    // A rejected set may not have changed anything. Preserve the original in that case.
    if (sameCookie(live, entry.original)) return true
    if (!sameCookie(live, entry.written)) return false
    if (entry.original) await within(() => session.cookies.set(details(entry.original!)))
    else {
      const matching = await within(() =>
        session.cookies.get({ url: cookieUrl(entry.candidate), name: entry.candidate.name })
      )
      if (matching.length !== 1 || !sameCookie(matching[0], entry.written)) return false
      await within(() => session.cookies.remove(cookieUrl(entry.candidate), entry.candidate.name))
    }
    return sameCookie(await within(() => current(entry.candidate)), entry.original)
  }
  const rollbackWindow = (): {
    within: <T>(operation: () => Promise<T>) => Promise<T>
    close: () => void
  } => {
    const rollbackStop = new AbortController()
    const rollbackTimer = setTimeout(() => rollbackStop.abort(), 5_000)
    rollbackTimer.unref?.()
    return {
      within: async <T>(operation: () => Promise<T>): Promise<T> => {
        if (rollbackStop.signal.aborted) throw new RecoveryError('rollback_conflict')
        let cancel: (() => void) | undefined
        try {
          return await Promise.race([
            operation(),
            new Promise<never>((_, reject) => {
              cancel = () => reject(new RecoveryError('rollback_conflict'))
              rollbackStop.signal.addEventListener('abort', cancel, { once: true })
            })
          ])
        } finally {
          if (cancel) rollbackStop.signal.removeEventListener('abort', cancel)
        }
      },
      close: () => clearTimeout(rollbackTimer)
    }
  }
  try {
    if (
      process.platform !== 'win32' ||
      tab.profile !== 'default' ||
      !samePath(app.getPath('userData'), expectedUserData) ||
      !session.getStoragePath() ||
      !samePath(session.getStoragePath()!, expectedStorage)
    )
      throw new RecoveryError('unsupported_context')
    context()
    auth = (await bounded(() => pageBridge.hyundaiAuth(tab))).state
    context()
    if (auth === 'signed_in') return { state: 'already_signed_in', auth, restoredCookies: 0 }
    if (auth === 'pin_ready') return { state: 'registration_present', auth, restoredCookies: 0 }
    if (auth !== 'registration_required') return { state: 'blocked', auth }
    if (attemptedSessions.has(session)) return { state: 'already_attempted', auth }
    candidates = await bounded(() => retainedCookies(home))
    for (const cookie of candidates) {
      previous.set(cookieIdentity(cookie), await bounded(() => current(cookie)))
      context()
    }
    auth = (await bounded(() => pageBridge.hyundaiAuth(tab))).state
    context()
    if (auth === 'signed_in') return { state: 'already_signed_in', auth, restoredCookies: 0 }
    if (auth === 'pin_ready') return { state: 'registration_present', auth, restoredCookies: 0 }
    if (auth !== 'registration_required') return { state: 'blocked', auth }
    if (attemptedSessions.has(session)) return { state: 'already_attempted', auth }
    attemptedSessions.add(session)
    for (const cookie of candidates) {
      if (!sameCookie(await bounded(() => current(cookie)), previous.get(cookieIdentity(cookie))))
        throw new RecoveryError('cookie_conflict')
      context()
      if (sameCookie(cookie, previous.get(cookieIdentity(cookie)))) continue
      const entry = {
        candidate: cookie,
        written: cookie,
        original: previous.get(cookieIdentity(cookie)),
        pending: Promise.resolve(),
        settled: false
      }
      // Track before invoking native set: it can commit and then reject, or finish
      // after a timeout. The mutation remains compensatable in either case.
      applied.push(entry)
      entry.pending = session.cookies.set(details(cookie)).finally(() => {
        entry.settled = true
      })
      await bounded(() => entry.pending)
      context()
      const written = await bounded(() => current(cookie))
      if (!written || !sameCookie(written, cookie)) throw new RecoveryError('cookie_restore_failed')
      entry.written = written
    }
    await bounded(() => session.cookies.flushStore())
    context()
    navigating = true
    await bounded(() => wc.loadURL(HYUNDAI_LOGIN_URL))
    context()
    // Loading the public entry reevaluates the existing issuer registration cookie.
    // Reading auth never enters PIN digits or invokes a registration/authentication flow.
    const deadline = Date.now() + 5_000
    do {
      auth = (await bounded(() => pageBridge.hyundaiAuth(tab))).state
      context()
      if (auth === 'signed_in' || auth === 'pin_ready')
        return { state: 'restored', auth, restoredCookies: applied.length }
      // Registration controls can remain visible while issuer AJAX initializes.
      // Wait the full short window for positive proof before deciding to undo.
      await bounded(
        () =>
          new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())))
      )
    } while (Date.now() < deadline)
    throw new RecoveryError('authentication_unchanged')
  } catch (error) {
    let rollbackConflict = false
    let unsettled = false
    const window = rollbackWindow()
    // Never overwrite normal browsing changes. Roll back only the exact values
    // this invocation wrote; original cookies and rollback data stay in memory.
    for (const entry of applied.reverse()) {
      try {
        if (!entry.settled) await window.within(() => entry.pending.catch(() => {}))
        if (!(await rollback(entry, window.within))) rollbackConflict = true
      } catch {
        rollbackConflict = true
        if (!entry.settled) {
          unsettled = true
          // Native cookie writes cannot be cancelled. Retain only this entry's
          // in-memory snapshot until settlement, then compensate only our value.
          void entry.pending
            .catch(() => {})
            .then(async () => {
              const late = rollbackWindow()
              try {
                if (await rollback(entry, late.within))
                  await late.within(() => session.cookies.flushStore())
              } catch {
                // No raw errors or secrets leave this fixed-scope operation.
              } finally {
                late.close()
              }
            })
        }
      }
    }
    try {
      if (applied.length) await window.within(() => session.cookies.flushStore())
    } catch {
      rollbackConflict = true
    } finally {
      window.close()
    }
    return {
      state: 'failed',
      auth,
      ...(rollbackConflict ? {} : { restoredCookies: 0 }),
      issue: unsettled
        ? 'mutation_unsettled'
        : rollbackConflict
          ? 'rollback_conflict'
          : error instanceof RecoveryError
            ? error.issue
            : 'cookie_restore_failed'
    }
  } finally {
    clearTimeout(timer)
    previous.clear()
    applied.length = 0
    candidates.length = 0
  }
}
