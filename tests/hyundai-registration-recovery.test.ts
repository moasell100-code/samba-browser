import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { app, type Cookie, type CookiesSetDetails } from 'electron'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { join } from 'node:path'
import type { Tab } from '../src/main/browser/tab-manager'
import { pageBridge } from '../src/main/browser/page-bridge'
import { HYUNDAI_LOGIN_URL } from '../src/main/finance/hyundai-login'
import {
  recoverHyundaiRegistration,
  type HyundaiRegistrationRecoveryResult
} from '../src/main/finance/hyundai-registration-recovery'

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  readFile: vi.fn()
}))
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => 'C:/Users/SYNTHETIC'
}))
vi.mock('electron', async (original) => ({
  ...(await original<typeof import('electron')>()),
  app: { getPath: vi.fn() }
}))

const HOME = 'C:/Users/SYNTHETIC'
const USER_DATA = join(HOME, '.jaja-browser')
const STORAGE = join(USER_DATA, 'Partitions', 'ws1-default')
const SOURCE = join(
  HOME,
  '.jaja-browser-backups',
  'storage-unification-20261007',
  'normal-profile',
  'Partitions',
  'ws1-default',
  'Network',
  'Cookies'
)
const EPOCH = 11_644_473_600
let SQL: SqlJsStatic
beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: (file) => require.resolve(`sql.js/dist/${file}`) })
})
beforeEach(() => {
  vi.mocked(app.getPath).mockReturnValue(USER_DATA)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.mocked(readFile).mockReset()
})

function sourceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    host_key: '.hyundaicard.com',
    name: 'SYNTHETIC_REGISTRATION',
    value: 'SYNTHETIC_BACKUP_SECRET',
    encrypted_value: new Uint8Array(),
    path: '/',
    expires_utc: Math.round((Date.now() / 1000 + 86_400 + EPOCH) * 1_000_000),
    is_secure: 1,
    is_httponly: 1,
    is_persistent: 1,
    samesite: 1,
    top_frame_site_key: '',
    ...overrides
  }
}

function backup(rows = [sourceRow()], version = '24'): void {
  const db = new SQL.Database()
  db.run('CREATE TABLE meta (key TEXT, value TEXT)')
  db.run('INSERT INTO meta VALUES (?, ?)', ['version', version])
  db.run(`CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB,
    path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER,
    is_persistent INTEGER, samesite INTEGER, top_frame_site_key TEXT)`)
  for (const row of rows) {
    const values = Object.values(row)
    // Bind raw UTF-8 bytes so fixtures preserve embedded NULs instead of having
    // sql.js string binding truncate them before SQLite can validate the source.
    values[1] = new Uint8Array(Buffer.from(String(row.name)))
    values[2] = new Uint8Array(Buffer.from(String(row.value)))
    db.run(
      'INSERT INTO cookies VALUES (?,CAST(? AS TEXT),CAST(? AS TEXT),?,?,?,?,?,?,?,?)',
      values as never
    )
  }
  const bytes = db.export()
  db.close()
  vi.mocked(readFile).mockImplementation(async (path) => {
    expect(path).toBe(SOURCE)
    return Buffer.from(bytes)
  })
}

function candidate(row = sourceRow()): Cookie {
  return {
    name: String(row.name),
    value: String(row.value),
    domain: String(row.host_key),
    hostOnly: !String(row.host_key).startsWith('.'),
    path: '/',
    secure: row.is_secure === 1,
    httpOnly: row.is_httponly === 1,
    session: false,
    sameSite: ['unspecified', 'no_restriction', 'lax', 'strict'][
      Number(row.samesite) + 1
    ] as Cookie['sameSite'],
    expirationDate: Number(row.expires_utc) / 1_000_000 - EPOCH
  }
}

interface RecoveryFixture {
  tab: Tab
  wc: {
    session: RecoveryFixture['session']
    loadURL: RecoveryFixture['loadURL']
    getURL: () => string
    isDestroyed: () => boolean
  }
  jar: Cookie[]
  session: {
    cookies: {
      get: RecoveryFixture['get']
      set: RecoveryFixture['set']
      remove: RecoveryFixture['remove']
      flushStore: RecoveryFixture['flushStore']
    }
    getStoragePath: () => string
  }
  get: ReturnType<typeof vi.fn<(filter: { url: string; name: string }) => Promise<Cookie[]>>>
  set: ReturnType<typeof vi.fn<(details: CookiesSetDetails) => Promise<void>>>
  commit: (details: CookiesSetDetails) => void
  remove: ReturnType<typeof vi.fn<(url: string, name: string) => Promise<void>>>
  flushStore: ReturnType<typeof vi.fn<() => Promise<void>>>
  loadURL: ReturnType<typeof vi.fn<(target: string) => Promise<void>>>
  auth: ReturnType<typeof vi.spyOn<typeof pageBridge, 'hyundaiAuth'>>
  setUrl: (next: string) => void
}

function fixture(initial: Cookie[] = []): RecoveryFixture {
  let url = 'https://www.hyundaicard.com/cpa/ma/CPAMA0101_01.hc'
  const jar = initial.map((cookie) => ({ ...cookie }))
  const identity = (cookie: Cookie): string =>
    JSON.stringify([cookie.name, cookie.domain?.replace(/^\./, ''), cookie.hostOnly, cookie.path])
  const get = vi.fn(async ({ url, name }: { url: string; name: string }) => {
    const host = new URL(url).hostname
    return jar
      .filter((cookie) => {
        const domain = cookie.domain!.replace(/^\./, '')
        return (
          cookie.name === name &&
          (cookie.hostOnly ? host === domain : host === domain || host.endsWith('.' + domain))
        )
      })
      .map((cookie) => ({ ...cookie }))
  })
  const commit = (details: CookiesSetDetails): void => {
    const cookie: Cookie = {
      name: details.name!,
      value: details.value!,
      domain: details.domain ?? new URL(details.url).hostname,
      hostOnly: details.domain === undefined,
      path: details.path ?? '/',
      secure: details.secure,
      httpOnly: details.httpOnly,
      sameSite: details.sameSite,
      session: details.expirationDate === undefined,
      expirationDate: details.expirationDate
    }
    const index = jar.findIndex((item) => identity(item) === identity(cookie))
    if (index < 0) jar.push(cookie)
    else jar[index] = cookie
  }
  const set = vi.fn(async (details: CookiesSetDetails) => commit(details))
  const remove = vi.fn(async (url: string, name: string) => {
    const selected = await get({ url, name })
    if (selected.length === 1)
      jar.splice(
        jar.findIndex((cookie) => identity(cookie) === identity(selected[0])),
        1
      )
  })
  const flushStore = vi.fn(async () => {})
  const session = { cookies: { get, set, remove, flushStore }, getStoragePath: () => STORAGE }
  const loadURL = vi.fn(async (target: string) => {
    url = target
  })
  const wc = { session, loadURL, getURL: () => url, isDestroyed: () => false }
  const tab = { profile: 'default', view: { webContents: wc } } as unknown as Tab
  const auth = vi.spyOn(pageBridge, 'hyundaiAuth').mockImplementation(async () => ({
    state: loadURL.mock.calls.length ? 'pin_ready' : 'registration_required'
  }))
  return {
    tab,
    wc,
    jar,
    session,
    get,
    set,
    commit,
    remove,
    flushStore,
    loadURL,
    auth,
    setUrl: (next: string) => {
      url = next
    }
  }
}

async function unchanged(f: RecoveryFixture): Promise<HyundaiRegistrationRecoveryResult> {
  vi.useFakeTimers()
  f.auth.mockResolvedValue({ state: 'registration_required' })
  const result = recoverHyundaiRegistration(f.tab)
  await vi.advanceTimersByTimeAsync(5_001)
  return await result
}

describe('fixed Hyundai registration cookie recovery', () => {
  it('restores only retained official-host cookies with exact expiry and flags', async () => {
    const row = sourceRow()
    const host = sourceRow({
      host_key: 'www.hyundaicard.com',
      name: 'SYNTHETIC_HOST',
      is_secure: 0,
      is_httponly: 0,
      samesite: -1
    })
    backup([row, host, sourceRow({ host_key: '.unrelated.invalid', name: 'SYNTHETIC_UNRELATED' })])
    const other = {
      ...candidate(),
      domain: '.unrelated.invalid',
      name: 'SYNTHETIC_OTHER',
      value: 'SYNTHETIC_OTHER_SECRET'
    }
    const f = fixture([other])
    expect(await recoverHyundaiRegistration(f.tab)).toEqual({
      state: 'restored',
      auth: 'pin_ready',
      restoredCookies: 2
    })
    expect(f.jar).toContainEqual(candidate(row))
    expect(f.jar).toContainEqual(candidate(host))
    expect(f.jar).toContainEqual(other)
    expect(f.set.mock.calls[1][0]).not.toHaveProperty('domain')
    expect(f.loadURL).toHaveBeenCalledExactlyOnceWith(HYUNDAI_LOGIN_URL)
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(f.remove).not.toHaveBeenCalled()
  })

  it.each([
    'signed_in',
    'pin_ready',
    'additional_auth',
    'pin_error',
    'unknown',
    'unsupported'
  ] as const)('does not read or write a backup for %s', async (state) => {
    const f = fixture()
    f.auth.mockResolvedValue({ state })
    const result = await recoverHyundaiRegistration(f.tab)
    expect(result.state).toBe(
      state === 'signed_in'
        ? 'already_signed_in'
        : state === 'pin_ready'
          ? 'registration_present'
          : 'blocked'
    )
    expect(readFile).not.toHaveBeenCalled()
    expect(f.set).not.toHaveBeenCalled()
    expect(f.loadURL).not.toHaveBeenCalled()
  })

  it.each([
    'other-user-data',
    'other-partition',
    'other-profile',
    'foreign-url',
    'credentials-url',
    'foreign-port'
  ])('fails closed in %s context', async (mode) => {
    const f = fixture()
    if (mode === 'other-user-data')
      vi.mocked(app.getPath).mockReturnValue(join(HOME, '.another-profile'))
    if (mode === 'other-partition')
      f.session.getStoragePath = () => join(USER_DATA, 'Partitions', 'ws2-default')
    if (mode === 'other-profile') f.tab.profile = 'private'
    if (mode === 'foreign-url') f.setUrl('https://attacker.invalid/')
    if (mode === 'credentials-url') f.setUrl('https://synthetic:secret@www.hyundaicard.com/')
    if (mode === 'foreign-port') f.setUrl('https://www.hyundaicard.com:444/')
    const result = await recoverHyundaiRegistration(f.tab)
    expect(result.state).toBe('failed')
    expect(readFile).not.toHaveBeenCalled()
    expect(f.set).not.toHaveBeenCalled()
  })

  it.each([
    { path: '/different' },
    { is_persistent: 0 },
    { top_frame_site_key: 'https://unrelated.invalid' },
    { is_secure: 3 },
    { is_httponly: 3 },
    { samesite: 8 },
    { name: 'BAD NAME' },
    { value: 'BAD\u0000VALUE' },
    { value: '' },
    { encrypted_value: new Uint8Array([1]) }
  ])('rejects unsupported retained source attributes %j before writing', async (override) => {
    backup([sourceRow(override)])
    const f = fixture()
    expect((await recoverHyundaiRegistration(f.tab)).state).toBe('failed')
    expect(f.set).not.toHaveBeenCalled()
    expect(f.loadURL).not.toHaveBeenCalled()
  })

  it('skips expired empty cookies without reviving or extending them', async () => {
    const row = sourceRow()
    backup([
      row,
      sourceRow({
        name: 'SYNTHETIC_EXPIRED',
        value: '',
        expires_utc: (EPOCH + Date.now() / 1000 - 1) * 1_000_000
      })
    ])
    const f = fixture()
    expect((await recoverHyundaiRegistration(f.tab)).restoredCookies).toBe(1)
    expect(f.jar).toEqual([candidate(row)])
  })

  it.each(['schema', 'empty', 'duplicate', 'excessive', 'unavailable'])(
    'rejects %s source without mutation',
    async (mode) => {
      if (mode === 'schema') backup([sourceRow()], '25')
      if (mode === 'empty') backup([])
      if (mode === 'duplicate')
        backup([sourceRow(), sourceRow({ host_key: 'www.hyundaicard.com' })])
      if (mode === 'excessive')
        backup(Array.from({ length: 101 }, (_, i) => sourceRow({ name: 'SYNTHETIC_' + i })))
      if (mode === 'unavailable')
        vi.mocked(readFile).mockRejectedValue(new Error('SYNTHETIC_SECRET_RAW_ERROR'))
      const f = fixture()
      const result = await recoverHyundaiRegistration(f.tab)
      expect(result.state).toBe('failed')
      expect(JSON.stringify(result)).not.toContain('SYNTHETIC')
      expect(f.set).not.toHaveBeenCalled()
    }
  )

  it('does not rewrite an identical live cookie', async () => {
    const row = sourceRow()
    backup([row])
    const f = fixture([candidate(row)])
    expect(await recoverHyundaiRegistration(f.tab)).toEqual({
      state: 'restored',
      auth: 'pin_ready',
      restoredCookies: 0
    })
    expect(f.set).not.toHaveBeenCalled()
  })

  it('waits for issuer AJAX positive proof even while registration remains visible', async () => {
    backup()
    const f = fixture()
    vi.useFakeTimers()
    f.auth.mockImplementation(async () => ({
      state:
        f.loadURL.mock.calls.length && Date.now() >= 1000 ? 'pin_ready' : 'registration_required'
    }))
    vi.setSystemTime(0)
    const result = recoverHyundaiRegistration(f.tab)
    await vi.advanceTimersByTimeAsync(1_001)
    expect((await result).state).toBe('restored')
    expect(f.remove).not.toHaveBeenCalled()
  })

  it('rolls back the exact prior value and flags if auth remains unregistered', async () => {
    const row = sourceRow()
    backup([row])
    const original = {
      ...candidate(row),
      value: 'SYNTHETIC_LIVE_SECRET',
      secure: false,
      httpOnly: false
    }
    const f = fixture([original])
    expect(await unchanged(f)).toEqual({
      state: 'failed',
      auth: 'registration_required',
      restoredCookies: 0,
      issue: 'authentication_unchanged'
    })
    expect(f.jar).toEqual([original])
    expect(f.set).toHaveBeenCalledTimes(2)
  })

  it('removes only the newly written cookie when there was no original', async () => {
    backup()
    const f = fixture()
    expect((await unchanged(f)).issue).toBe('authentication_unchanged')
    expect(f.jar).toEqual([])
    expect(f.remove).toHaveBeenCalledExactlyOnceWith(
      'https://hyundaicard.com/',
      'SYNTHETIC_REGISTRATION'
    )
  })

  it('preserves a normal browsing change during rollback', async () => {
    backup()
    const f = fixture()
    f.loadURL.mockImplementation(async () => {
      f.jar[0].value = 'SYNTHETIC_NORMAL_USAGE_SECRET'
    })
    expect((await unchanged(f)).issue).toBe('rollback_conflict')
    expect(f.jar[0].value).toBe('SYNTHETIC_NORMAL_USAGE_SECRET')
    expect(f.remove).not.toHaveBeenCalled()
    expect(f.set).toHaveBeenCalledTimes(1)
  })

  it('rolls back even if native set commits and then rejects', async () => {
    backup()
    const f = fixture()
    f.set.mockImplementationOnce(async (details) => {
      f.commit(details)
      throw new Error('SYNTHETIC_SECRET_ERROR')
    })
    expect((await recoverHyundaiRegistration(f.tab)).issue).toBe('cookie_restore_failed')
    expect(f.jar).toEqual([])
    expect(f.remove).toHaveBeenCalledTimes(1)
  })

  it('does not mutate if normal browsing changed a candidate before its set', async () => {
    const row = sourceRow()
    backup([row])
    const original = { ...candidate(row), value: 'SYNTHETIC_ORIGINAL' }
    const f = fixture([original])
    f.auth.mockImplementation(async () => {
      if (f.auth.mock.calls.length === 2) f.jar[0].value = 'SYNTHETIC_NORMAL_USAGE'
      return { state: 'registration_required' }
    })
    expect((await recoverHyundaiRegistration(f.tab)).issue).toBe('cookie_conflict')
    expect(f.jar[0].value).toBe('SYNTHETIC_NORMAL_USAGE')
    expect(f.set).not.toHaveBeenCalled()
  })

  it('refuses ambiguous live same-name cookie scopes', async () => {
    const row = sourceRow({ host_key: 'www.hyundaicard.com' })
    backup([row])
    const f = fixture([{ ...candidate(row), hostOnly: false, domain: '.hyundaicard.com' }])
    expect((await recoverHyundaiRegistration(f.tab)).issue).toBe('cookie_conflict')
    expect(f.set).not.toHaveBeenCalled()
  })

  it('aborts without mutation or backup access when already cancelled', async () => {
    const f = fixture()
    expect((await recoverHyundaiRegistration(f.tab, AbortSignal.abort())).issue).toBe('cancelled')
    expect(readFile).not.toHaveBeenCalled()
    expect(f.set).not.toHaveBeenCalled()
  })

  it('rolls back if the tab is replaced immediately after native set', async () => {
    backup()
    const f = fixture()
    f.set.mockImplementationOnce(async (details) => {
      f.commit(details)
      f.tab.view = { webContents: { ...f.wc } } as Tab['view']
    })
    expect((await recoverHyundaiRegistration(f.tab)).issue).toBe('navigation_changed')
    expect(f.jar).toEqual([])
  })

  it('bounds a stalled read to thirty seconds', async () => {
    const f = fixture()
    vi.useFakeTimers()
    f.auth.mockImplementation(() => new Promise(() => {}))
    const result = recoverHyundaiRegistration(f.tab)
    await vi.advanceTimersByTimeAsync(30_001)
    expect((await result).issue).toBe('timeout')
    expect(f.set).not.toHaveBeenCalled()
  })

  it('tracks a stalled native mutation and compensates a late commit in memory', async () => {
    backup()
    const f = fixture()
    vi.useFakeTimers()
    let finish: (() => void) | undefined
    f.set.mockImplementationOnce(
      (details) =>
        new Promise<void>((resolve) => {
          finish = () => {
            f.commit(details)
            resolve()
          }
        })
    )
    const result = recoverHyundaiRegistration(f.tab)
    await vi.advanceTimersByTimeAsync(35_001)
    expect((await result).issue).toBe('mutation_unsettled')
    expect(f.jar).toEqual([])
    finish!()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.jar).toEqual([])
    expect(f.remove).toHaveBeenCalledTimes(1)
  })

  it('allows only one mutation attempt per live session', async () => {
    backup()
    const f = fixture()
    await recoverHyundaiRegistration(f.tab)
    f.auth.mockResolvedValue({ state: 'registration_required' })
    expect(await recoverHyundaiRegistration(f.tab)).toEqual({
      state: 'already_attempted',
      auth: 'registration_required'
    })
    expect(f.set).toHaveBeenCalledTimes(1)
    expect(readFile).toHaveBeenCalledTimes(1)
  })
})
