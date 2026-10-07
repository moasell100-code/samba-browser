import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { describe, expect, it, vi } from 'vitest'

// Run the actual bootstrap/window modules without Electron or a real user profile.
const sources = Object.fromEntries(
  ['index', 'window'].map((name) => [
    name,
    transpileModule(readFileSync(resolve(__dirname, `../src/main/${name}.ts`), 'utf8'), {
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText
  ])
)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

function bootstrap(options: { validation?: boolean; devUrl?: string; packaged?: boolean } = {}) {
  const events: string[] = []
  const database = deferred<{ bookmarks: string[] }>()
  const firstReads: string[][] = []
  let readBookmarks: (() => string[]) | undefined
  let startup!: Promise<void>
  const quit = vi.fn()
  const loads: Array<{ kind: 'file' | 'url'; target: string }> = []
  const windows: Array<{ webPreferences: { preload: string; contextIsolation: boolean } }> = []
  const load = async (kind: 'file' | 'url', target: string) => {
    events.push('renderer')
    loads.push({ kind, target })
    if (!readBookmarks) throw new Error('No handler registered for bookmarks:tree')
    firstReads.push(readBookmarks())
  }
  const modules: Record<string, unknown> = {
    'node:path': { join },
    path: { join },
    electron: {
      app: {
        isPackaged: !!options.packaged,
        setPath: vi.fn(),
        getPath: () => 'synthetic-profile',
        getAppPath: () => 'synthetic-app',
        setName: vi.fn(),
        requestSingleInstanceLock: () => true,
        on: vi.fn(),
        setAppUserModelId: vi.fn(),
        quit,
        whenReady: () => ({
          then: (start: () => Promise<void>) => (startup = Promise.resolve().then(start))
        })
      },
      BrowserWindow: class {
        constructor(settings: (typeof windows)[number]) {
          windows.push(settings)
          events.push('window')
        }
        setAppDetails = vi.fn()
        on = vi.fn()
        webContents = { setWindowOpenHandler: vi.fn() }
        loadFile = (target: string) => load('file', target)
        loadURL = (target: string) => load('url', target)
      },
      shell: {},
      crashReporter: { start: vi.fn() },
      powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
      session: { defaultSession: {} }
    },
    '@electron-toolkit/utils': {
      is: { dev: !options.packaged },
      optimizer: { watchWindowShortcuts: vi.fn() }
    },
    '../shared/url': { isHttpUrl: () => true },
    './browser/tab-manager': {
      TabManager: class {
        create() {
          events.push('tab')
        }
      }
    },
    './browser/request-hooks': { installSessionRequestHooks: vi.fn() },
    './browser/popups': { markQuitting: vi.fn() },
    './browser/internal-protocol': {
      registerInternalProtocol: vi.fn(),
      registerInternalScheme: vi.fn()
    },
    './ipc/handlers': {
      registerIpc: (_win: unknown, _tabs: unknown, db: { bookmarks: string[] }) => {
        events.push('ipc')
        readBookmarks = () => db.bookmarks
        return { vault: {}, sync: {}, cardDaily: { start: vi.fn() } }
      }
    },
    './ipc/favicon': { registerFaviconIpc: vi.fn() },
    './db/client': {
      openDatabase: () => {
        events.push('database')
        return database.promise
      }
    },
    './e2e/login-harness': {},
    './jaja/ipc': {
      registerJaja: () => {
        events.push('jaja')
        return {}
      }
    },
    './jaja/validation-fixtures': { registerValidationFixtures: vi.fn() },
    './jaja/validation-ipc': {
      registerValidationIpc: () => {
        events.push('validation-ipc')
        readBookmarks = () => ['validation bookmark']
      }
    },
    './finance/card-diagnostics-runtime': {},
    './finance/profile-process-lock': {
      acquireProfileProcessLock: async () => ({ release: vi.fn() })
    },
    './user-data': { browserUserDataPath: () => undefined },
    './jaja/validation': {
      isJajaValidation: () => !!options.validation,
      configureValidationProfile: vi.fn(),
      registerValidationNetwork: vi.fn()
    }
  }
  const fakeProcess = {
    platform: 'win32',
    execPath: 'synthetic-electron.exe',
    argv: [],
    env: { ELECTRON_RENDERER_URL: options.devUrl },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn()
  }
  function execute(name: string) {
    const exports = {}
    runInNewContext(sources[name], {
      exports,
      __dirname: dirname(resolve(__dirname, '../src/main/index.ts')),
      process: fakeProcess,
      console: { error: vi.fn(), warn: vi.fn() },
      require: (id: string) => {
        if (!(id in modules)) throw new Error(`Unexpected bootstrap dependency: ${id}`)
        return modules[id]
      }
    })
    return exports
  }
  modules['./window'] = execute('window')
  execute('index')
  return { events, database, firstReads, loads, windows, quit, startup }
}

describe('main renderer startup readiness', () => {
  it('waits for a delayed database and IPC before the first bookmark query', async () => {
    const boot = bootstrap()
    await vi.waitFor(() => expect(boot.events).toContain('database'))
    expect(boot.loads).toEqual([])
    boot.database.resolve({ bookmarks: ['saved bookmark'] })
    await boot.startup
    expect(boot.events).toEqual(['window', 'database', 'ipc', 'jaja', 'renderer', 'tab'])
    expect(boot.firstReads).toEqual([['saved bookmark']])
    expect(boot.loads).toEqual([
      { kind: 'file', target: resolve(__dirname, '../src/renderer/index.html') }
    ])
    expect(boot.windows[0].webPreferences).toMatchObject({
      preload: resolve(__dirname, '../src/preload/renderer.js'),
      contextIsolation: true
    })
  })

  it('keeps the renderer unloaded and quits when opening the database fails', async () => {
    const boot = bootstrap()
    await vi.waitFor(() => expect(boot.events).toContain('database'))
    boot.database.reject(new Error('database unavailable'))
    await expect(boot.startup).rejects.toThrow('database unavailable')
    expect(boot.loads).toEqual([])
    expect(boot.quit).toHaveBeenCalledOnce()
  })

  it('loads validation fixtures after their IPC registration without opening the user DB', async () => {
    const boot = bootstrap({ validation: true, devUrl: 'http://localhost:5173' })
    await boot.startup
    expect(boot.events).toEqual(['window', 'validation-ipc', 'jaja', 'tab', 'renderer'])
    expect(boot.firstReads).toEqual([['validation bookmark']])
    expect(boot.loads[0].kind).toBe('file')
  })

  it.each([false, true])('preserves renderer selection when packaged=%s', async (packaged) => {
    const boot = bootstrap({ packaged, devUrl: 'http://localhost:5173' })
    boot.database.resolve({ bookmarks: [] })
    await boot.startup
    expect(boot.loads[0]).toEqual({
      kind: packaged ? 'file' : 'url',
      target: packaged ? resolve(__dirname, '../src/renderer/index.html') : 'http://localhost:5173'
    })
  })
})
