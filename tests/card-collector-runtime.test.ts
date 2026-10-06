import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSettings } from '../src/shared/settings'
import type { CardDailyStatus } from '../src/shared/card-daily'
import {
  runCardCollectorLifecycle,
  runCardCollectorOnly,
  writeCardCollectorStatus,
  waitForCardCollectorNetwork,
  type CardCollectorResources,
  type CardCollectorStatus
} from '../src/main/finance/card-collector-runtime'

const native = vi.hoisted(() => ({
  settings: undefined as ReturnType<typeof parseSettings> | undefined,
  windows: [] as Array<Record<string, unknown>>,
  managerOptions: [] as Array<Record<string, unknown>>,
  scope: vi.fn(),
  partition: vi.fn(),
  layout: vi.fn(),
  closeDb: vi.fn(),
  disposeVault: vi.fn(),
  disposeTabs: vi.fn(),
  destroyWindow: vi.fn(),
  dailyOptions: undefined as Record<string, unknown> | undefined,
  tick: vi.fn(),
  disposeDaily: vi.fn(),
  report: vi.fn(),
  status: undefined as CardDailyStatus | undefined,
  rows: [{ id: 1 }, { id: 2 }]
}))
vi.mock('electron', () => ({
  safeStorage: {},
  BrowserWindow: class {
    constructor(options: Record<string, unknown>) {
      native.windows.push(options)
    }
    webContents = { setWindowOpenHandler: vi.fn() }
    isDestroyed(): boolean {
      return false
    }
    destroy = native.destroyWindow
  }
}))
vi.mock('node:tls', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    connect: () => {
      const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() })
      queueMicrotask(() => socket.emit('secureConnect'))
      return socket
    }
  }
})
vi.mock('node:net', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    connect: () => {
      const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() })
      queueMicrotask(() => socket.emit('connect'))
      return socket
    }
  }
})
vi.mock('../src/main/settings/store', () => ({
  SettingsStore: class {
    get(): ReturnType<typeof parseSettings> {
      return native.settings!
    }
  }
}))
vi.mock('../src/main/db/client', () => ({
  openDatabase: async () => ({
    close: native.closeDb,
    drizzle: {
      select: () => ({
        from: () => ({ where: () => ({ orderBy: () => ({ all: () => native.rows }) }) })
      })
    }
  })
}))
vi.mock('../src/main/vault/service', () => ({
  VaultService: class {
    state(): string {
      return 'unlocked'
    }
    setWorkspaceScope = native.scope
    dispose = native.disposeVault
  }
}))
vi.mock('../src/main/browser/tab-manager', () => ({
  TabManager: class {
    constructor(_window: unknown, options: Record<string, unknown>) {
      native.managerOptions.push(options)
    }
    setPartitionPrefix = native.partition
    setLayout = native.layout
    setAgentRunningProvider = vi.fn()
    setDialogPolicy = vi.fn()
    dispose = native.disposeTabs
  }
}))
vi.mock('../src/main/finance/card-daily-runtime', () => ({
  createCardDailyRuntime: (options: Record<string, unknown>) => {
    native.dailyOptions = options
    return { tick: native.tick, dispose: native.disposeDaily, status: () => native.status }
  }
}))
vi.mock('../src/main/finance/card-schedule-report', () => ({ reportCardSchedule: native.report }))

function setup(): {
  resources: CardCollectorResources
  statuses: CardCollectorStatus[]
  run: (options?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<string>
  open: ReturnType<typeof vi.fn>
} {
  const resources: CardCollectorResources = {
    ready: vi.fn().mockResolvedValue(true),
    tick: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(true),
    status: () => ({ phase: 'completed' }),
    vaultUnlocked: () => true,
    stop: vi.fn(),
    dispose: vi.fn()
  }
  const open = vi.fn().mockResolvedValue(resources)
  const statuses: CardCollectorStatus[] = []
  return {
    resources,
    open,
    statuses,
    run: (options = {}) =>
      runCardCollectorLifecycle({
        open,
        write: (status) => statuses.push(status),
        now: () => Date.parse('2026-10-06T00:00:00Z'),
        ...options
      })
  }
}

afterEach(() => vi.useRealTimers())

describe('bounded card collector lifecycle', () => {
  it('does not consume a scheduler or login claim when boot networking is unavailable', async () => {
    const context = setup()
    vi.mocked(context.resources.ready).mockResolvedValue(false)
    expect(await context.run()).toBe('failed')
    expect(context.resources.tick).not.toHaveBeenCalled()
    expect(context.resources.flush).not.toHaveBeenCalled()
    expect(context.resources.dispose).toHaveBeenCalledOnce()
  })
  it('runs one existing scheduler tick and awaits the final report before disposing', async () => {
    const context = setup()
    let acknowledge: ((value: boolean) => void) | undefined
    vi.mocked(context.resources.flush).mockReturnValue(
      new Promise((resolve) => {
        acknowledge = resolve
      })
    )
    const result = context.run()
    await vi.waitFor(() => expect(context.resources.flush).toHaveBeenCalledOnce())
    expect(context.resources.dispose).not.toHaveBeenCalled()
    acknowledge!(true)
    expect(await result).toBe('completed')
    expect(context.resources.tick).toHaveBeenCalledOnce()
    expect(context.resources.dispose).toHaveBeenCalledOnce()
    expect(context.statuses.map((row) => row.state)).toEqual(['starting', 'running', 'completed'])
  })

  it('preserves review and authentication attention states after a finished tick', async () => {
    const context = setup()
    context.resources.status = () => ({ phase: 'needs_attention' })
    expect(await context.run()).toBe('needs_attention')
  })

  it('does not report completed when the final server status acknowledgement fails', async () => {
    const context = setup()
    vi.mocked(context.resources.flush).mockResolvedValue(false)
    expect(await context.run()).toBe('needs_attention')
  })

  it('does not open a vault or browser when already cancelled', async () => {
    const context = setup()
    const controller = new AbortController()
    controller.abort()
    expect(await context.run({ signal: controller.signal })).toBe('stopped')
    expect(context.open).not.toHaveBeenCalled()
  })

  it('times out a stalled operation, stops native work and closes resources without retry', async () => {
    vi.useFakeTimers()
    const context = setup()
    let interrupted: (() => void) | undefined
    vi.mocked(context.resources.tick).mockReturnValue(
      new Promise<void>((resolve) => {
        interrupted = resolve
      })
    )
    vi.mocked(context.resources.stop).mockImplementation(() => interrupted?.())
    const result = context.run({ timeoutMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toBe('timed_out')
    expect(context.resources.tick).toHaveBeenCalledOnce()
    expect(context.resources.dispose).toHaveBeenCalledOnce()
    expect(context.resources.flush).not.toHaveBeenCalled()
  })

  it('retains no exception text in status and still closes the vault on failure', async () => {
    const context = setup()
    vi.mocked(context.resources.tick).mockRejectedValue(new Error('PRIVATE-INPUT-MUST-NOT-LEAK'))
    expect(await context.run()).toBe('failed')
    expect(context.resources.dispose).toHaveBeenCalledOnce()
    expect(JSON.stringify(context.statuses)).not.toContain('PRIVATE')
    expect(Object.keys(context.statuses.at(-1)!)).toEqual([
      'version',
      'mode',
      'state',
      'vaultUnlocked',
      'startedAt',
      'updatedAt'
    ])
  })

  it('closes resources returned after a cancelled initialization instead of starting work', async () => {
    vi.useFakeTimers()
    const context = setup()
    let complete: ((value: CardCollectorResources) => void) | undefined
    context.open.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve
      })
    )
    const controller = new AbortController()
    const result = context.run({ signal: controller.signal })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    complete!(context.resources)
    expect(await result).toBe('stopped')
    expect(context.resources.tick).not.toHaveBeenCalled()
    expect(context.resources.dispose).toHaveBeenCalledOnce()
  })

  it('atomically saves only the fixed runtime status to a synthetic profile', () => {
    const directory = mkdtempSync(join(tmpdir(), 'card-runtime-test-'))
    try {
      const status: CardCollectorStatus = {
        version: 1,
        mode: 'card_collector_only',
        state: 'completed',
        vaultUnlocked: false,
        startedAt: '2026-10-06T00:00:00.000Z',
        updatedAt: '2026-10-06T00:00:01.000Z'
      }
      writeCardCollectorStatus(directory, status)
      expect(
        JSON.parse(readFileSync(join(directory, 'collector-runtime-status.json'), 'utf8'))
      ).toEqual(status)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('collector-only native wiring', () => {
  let directory: string
  beforeEach(() => {
    vi.clearAllMocks()
    native.windows.length = 0
    native.managerOptions.length = 0
    native.rows = [{ id: 1 }, { id: 2 }]
    native.settings = parseSettings({
      activeWorkspaceId: 2,
      financeDailyEnabled: true,
      financeDailyHourKst: 9,
      financeCollectorTransport: 'server-ssh'
    })
    native.status = {
      enabled: true,
      hourKst: 9,
      phase: 'completed',
      gapDays: 0,
      runDate: '2026-10-06',
      nextRunAt: '2026-10-07T00:00:00Z',
      results: [{ issuer: 'hyundai_card', state: 'saved', insertedRows: 0, updatedRows: 0 }]
    }
    native.tick.mockResolvedValue(undefined)
    native.report.mockResolvedValue(true)
    directory = mkdtempSync(join(tmpdir(), 'card-native-test-'))
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('uses the selected workspace and existing attempt store with an invisible bounded worker', async () => {
    expect(await runCardCollectorOnly(directory)).toBe('completed')
    expect(native.windows).toEqual([expect.objectContaining({ show: false, skipTaskbar: true })])
    expect(native.windows[0]).not.toHaveProperty('preload')
    expect(native.managerOptions).toEqual([{ collectorOnly: true }])
    expect(native.scope).toHaveBeenCalledWith({ id: 2, isDefault: false })
    expect(native.partition).toHaveBeenCalledWith('persist:ws2-')
    expect(native.layout).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1440, height: 900 })
    )
    expect(native.dailyOptions?.stateFile).toBe(join(directory, 'card-daily-runs.json'))
    expect(native.tick).toHaveBeenCalledOnce()
    expect(native.report).toHaveBeenCalledOnce()
    expect(native.report.mock.calls[0][0].results).toEqual([
      expect.objectContaining({ issuer: 'hyundai_card', state: 'saved' })
    ])
    expect(native.closeDb).toHaveBeenCalledOnce()
    expect(native.disposeVault).toHaveBeenCalledOnce()
  })

  it('fails closed when the selected workspace no longer exists, without falling back', async () => {
    native.rows = [{ id: 1 }]
    expect(await runCardCollectorOnly(directory)).toBe('failed')
    expect(native.windows).toHaveLength(0)
    expect(native.scope).not.toHaveBeenCalled()
    expect(native.tick).not.toHaveBeenCalled()
    expect(native.closeDb).toHaveBeenCalledOnce()
    expect(native.settings!.activeWorkspaceId).toBe(2)
  })
})

describe('boot network readiness without card requests', () => {
  it('allows healthy issuers to run when one issuer is unavailable', async () => {
    expect(
      await waitForCardCollectorNetwork({
        transport: 'server-ssh',
        signal: new AbortController().signal,
        probe: async (host) => host !== 'www.hyundaicard.com',
        sleep: async () => {
          throw new Error('No retry needed')
        }
      })
    ).toBe(true)
  })

  it('waits until fixed card TLS and the SSH transport endpoint are reachable', async () => {
    let now = 0
    const probe = vi.fn(async () => now > 0)
    const sleep = vi.fn(async (ms: number) => {
      now += ms
    })
    const result = await waitForCardCollectorNetwork({
      transport: 'server-ssh',
      signal: new AbortController().signal,
      now: () => now,
      probe,
      sleep,
      timeoutMs: 30_000
    })
    expect(result).toBe(true)
    expect(probe).toHaveBeenCalledTimes(8)
    expect(probe.mock.calls.slice(0, 4).map((args) => args.slice(0, 3))).toEqual([
      ['www.hyundaicard.com', 443, true],
      ['www.samsungcard.com', 443, true],
      ['www.lottecard.co.kr', 443, true],
      ['100.82.217.10', 22, false]
    ])
  })

  it('bounds offline retries and uses the existing local collector port', async () => {
    let now = 0
    const probe = vi.fn(async () => false)
    expect(
      await waitForCardCollectorNetwork({
        transport: 'local',
        signal: new AbortController().signal,
        now: () => now,
        probe,
        sleep: async (ms) => {
          now += ms
        },
        timeoutMs: 30_000
      })
    ).toBe(false)
    expect(now).toBe(30_000)
    expect(probe).toHaveBeenCalledTimes(8)
    expect(probe.mock.calls[3].slice(0, 3)).toEqual(['127.0.0.1', 8000, false])
  })

  it('stops readiness immediately on shutdown without another probe cycle', async () => {
    const controller = new AbortController()
    const probe = vi.fn(async () => false)
    expect(
      await waitForCardCollectorNetwork({
        transport: 'server-ssh',
        signal: controller.signal,
        probe,
        sleep: async () => controller.abort()
      })
    ).toBe(false)
    expect(probe).toHaveBeenCalledTimes(4)
  })
})
