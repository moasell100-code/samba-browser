import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { connect as connectTcp } from 'node:net'
import { connect as connectTls } from 'node:tls'
import type { CardDailyStatus } from '../../shared/card-daily'

export type CardCollectorState =
  'starting' | 'running' | 'completed' | 'needs_attention' | 'failed' | 'timed_out' | 'stopped'

export interface CardCollectorStatus {
  version: 1
  mode: 'card_collector_only'
  state: CardCollectorState
  vaultUnlocked: boolean
  startedAt: string
  updatedAt: string
}

export interface CardCollectorResources {
  ready(): Promise<boolean>
  tick(): Promise<void>
  flush(): Promise<boolean>
  status(): Pick<CardDailyStatus, 'phase'>
  vaultUnlocked(): boolean
  stop(): void
  dispose(): void
}

const CARD_NETWORK_HOSTS = [
  'www.hyundaicard.com',
  'www.samsungcard.com',
  'www.lottecard.co.kr'
] as const

function probeSocket(
  host: string,
  port: number,
  tls: boolean,
  signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    const socket = tls
      ? connectTls({
          host,
          port,
          servername: host,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2'
        })
      : connectTcp({ host, port })
    const done = (ready: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      socket.destroy()
      resolve(ready)
    }
    const abort = (): void => done(false)
    const timer = setTimeout(abort, 8000)
    socket.once(tls ? 'secureConnect' : 'connect', () => done(true))
    socket.once('error', abort)
    socket.once('close', abort)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

function waitNetworkRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    if (signal.aborted) done()
  })
}

/** Connectivity only: no HTTP request, card session, login attempt, database write or secret. */
export async function waitForCardCollectorNetwork(options: {
  transport: 'server-ssh' | 'local'
  signal: AbortSignal
  now?: () => number
  probe?: (host: string, port: number, tls: boolean, signal: AbortSignal) => Promise<boolean>
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  timeoutMs?: number
}): Promise<boolean> {
  const now = options.now ?? Date.now
  const probe = options.probe ?? probeSocket
  const sleep = options.sleep ?? waitNetworkRetry
  const deadline = now() + (options.timeoutMs ?? 5 * 60_000)
  while (!options.signal.aborted && now() < deadline) {
    const targets: Array<[string, number, boolean]> = CARD_NETWORK_HOSTS.map((host) => [
      host,
      443,
      true
    ])
    targets.push(
      options.transport === 'server-ssh' ? ['100.82.217.10', 22, false] : ['127.0.0.1', 8000, false]
    )
    const cycle = new AbortController()
    const cycleTimer = setTimeout(() => cycle.abort(), Math.min(8000, deadline - now()))
    const cycleSignal = AbortSignal.any([options.signal, cycle.signal])
    let results: PromiseSettledResult<boolean>[]
    try {
      results = await Promise.allSettled(
        targets.map(([host, port, tls]) =>
          Promise.resolve().then(() => probe(host, port, tls, cycleSignal))
        )
      )
    } finally {
      clearTimeout(cycleTimer)
      cycle.abort()
    }
    if (options.signal.aborted) return false
    const reachable = (result: PromiseSettledResult<boolean>): boolean =>
      result.status === 'fulfilled' && result.value === true
    // An individual issuer outage must not prevent the other issuers from being collected.
    // Establish Internet availability and the destination route before consuming any claims.
    if (results.slice(0, CARD_NETWORK_HOSTS.length).some(reachable) && reachable(results[3]))
      return true
    const remaining = deadline - now()
    if (remaining <= 0) return false
    await sleep(Math.min(15_000, remaining), options.signal)
  }
  return false
}

/** One bounded task occurrence; the existing scheduler still owns due dates and attempt claims. */
export async function runCardCollectorLifecycle(options: {
  open(signal: AbortSignal): Promise<CardCollectorResources>
  write(status: CardCollectorStatus): void
  signal?: AbortSignal
  now?: () => number
  timeoutMs?: number
}): Promise<CardCollectorState> {
  const now = options.now ?? Date.now
  const startedAt = new Date(now()).toISOString()
  const controller = new AbortController()
  let resources: CardCollectorResources | undefined
  let timedOut = false
  let active: Promise<unknown> | undefined
  let state: CardCollectorState = 'starting'
  const publish = (): void =>
    options.write({
      version: 1,
      mode: 'card_collector_only',
      state,
      vaultUnlocked: resources?.vaultUnlocked() === true,
      startedAt,
      updatedAt: new Date(now()).toISOString()
    })
  const stop = (): void => controller.abort()
  options.signal?.addEventListener('abort', stop, { once: true })
  if (options.signal?.aborted) stop()
  const timer = setTimeout(
    () => {
      timedOut = true
      stop()
    },
    options.timeoutMs ?? 35 * 60_000
  )
  const interrupted = new Promise<never>((_resolve, reject) => {
    const abort = (): void => {
      resources?.stop()
      reject(new Error('Card collector stopped'))
    }
    if (controller.signal.aborted) abort()
    else controller.signal.addEventListener('abort', abort, { once: true })
  })
  // A pre-aborted caller must not leave an unhandled rejected promise before the first race.
  void interrupted.catch(() => undefined)
  try {
    publish()
    if (controller.signal.aborted) throw new Error('Card collector stopped')
    active = options.open(controller.signal).then((opened) => {
      resources = opened
      if (controller.signal.aborted) {
        opened.stop()
        opened.dispose()
        resources = undefined
        throw new Error('Card collector stopped')
      }
    })
    await Promise.race([active, interrupted])
    if (controller.signal.aborted) throw new Error('Card collector stopped')
    state = 'running'
    publish()
    active = resources!.ready()
    const ready = await Promise.race([active, interrupted])
    if (controller.signal.aborted) throw new Error('Card collector stopped')
    if (!ready) throw new Error('Card collector network unavailable')
    active = resources!.tick()
    await Promise.race([active, interrupted])
    if (controller.signal.aborted) throw new Error('Card collector stopped')
    active = resources!.flush()
    const reported = await Promise.race([active, interrupted])
    if (controller.signal.aborted) throw new Error('Card collector stopped')
    state =
      !reported || resources!.status().phase === 'needs_attention' ? 'needs_attention' : 'completed'
  } catch {
    state = timedOut ? 'timed_out' : controller.signal.aborted ? 'stopped' : 'failed'
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', stop)
    resources?.stop()
    // Native login/query paths observe scheduler abort; let them persist interrupted claims
    // before closing the vault/SQL.js file. An unresponsive renderer cannot hold shutdown forever.
    if (active) {
      let settleTimer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        active.catch(() => undefined),
        new Promise<void>((resolve) => {
          settleTimer = setTimeout(resolve, 5000)
        })
      ])
      if (settleTimer) clearTimeout(settleTimer)
    }
    try {
      publish()
    } catch {
      state = 'failed'
    }
    resources?.dispose()
  }
  return state
}

/** Never writes errors, URLs, account identifiers, amounts, credential lengths or raw pages. */
export function writeCardCollectorStatus(userData: string, status: CardCollectorStatus): void {
  const file = join(userData, 'collector-runtime-status.json')
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(status), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, file)
  } finally {
    try {
      unlinkSync(temporary)
    } catch {
      /* Atomic rename already removed the temporary file. */
    }
  }
}

async function openCollectorResources(
  userData: string,
  signal: AbortSignal
): Promise<CardCollectorResources> {
  // Dynamic loading makes the lifecycle testable without Electron and keeps ordinary app
  // initialization (IPC, account sync, Jaja, playbooks and model providers) out of this path.
  const [
    { BrowserWindow, safeStorage },
    { SettingsStore },
    { openDatabase },
    { VaultService },
    { TabManager },
    { createCardDailyRuntime },
    { reportCardSchedule },
    { CARD_DAILY_ISSUERS },
    { workspaces },
    { asc, isNull }
  ] = await Promise.all([
    import('electron'),
    import('../settings/store'),
    import('../db/client'),
    import('../vault/service'),
    import('../browser/tab-manager'),
    import('./card-daily-runtime'),
    import('./card-schedule-report'),
    import('../../shared/card-daily'),
    import('../db/schema'),
    import('drizzle-orm')
  ])
  if (signal.aborted) throw new Error('Card collector stopped')
  const settings = new SettingsStore()
  const db = await openDatabase(join(userData, 'data.db'))
  let vault: InstanceType<typeof VaultService> | undefined
  let win: InstanceType<typeof BrowserWindow> | undefined
  let tabs: InstanceType<typeof TabManager> | undefined
  let daily: ReturnType<typeof createCardDailyRuntime> | undefined
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    daily?.dispose()
    tabs?.dispose()
    if (win && !win.isDestroyed()) win.destroy()
    vault?.dispose()
    db.close()
  }
  try {
    if (signal.aborted) throw new Error('Card collector stopped')
    // Reuse the explicitly selected local workspace; never fall back to another account,
    // create a workspace or reset the user's selection while running unattended.
    const activeId = settings.get().activeWorkspaceId
    const rows = db.drizzle
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(isNull(workspaces.deletedAt))
      .orderBy(asc(workspaces.position), asc(workspaces.id))
      .all()
    if (!rows.some((row) => row.id === activeId)) throw new Error('Card workspace unavailable')
    vault = new VaultService(db, settings, { safeStorage })
    vault.setWorkspaceScope({ id: activeId, isDefault: rows[0]?.id === activeId })
    win = new BrowserWindow({
      width: 1440,
      height: 900,
      useContentSize: true,
      show: false,
      skipTaskbar: true,
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false }
    })
    // No renderer document is loaded and no IPC handlers or general bridge are registered.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    tabs = new TabManager(win, { collectorOnly: true })
    tabs.setPartitionPrefix(`persist:ws${activeId}-`)
    tabs.setLayout({
      x: 0,
      y: 0,
      width: 1440,
      height: 900,
      viewportWidth: 1440,
      viewportHeight: 900
    })
    let acquired = false
    tabs.setAgentRunningProvider(() => acquired)
    tabs.setDialogPolicy({ mode: () => 'guard', confirm: async () => false })
    daily = createCardDailyRuntime({
      tabs,
      vault,
      settings: () => settings.get(),
      stateFile: join(userData, 'card-daily-runs.json'),
      agent: {
        isRunning: () => false,
        tryAcquireCardAutomation: () => {
          if (acquired) return null
          acquired = true
          return () => {
            acquired = false
          }
        }
      },
      // The single-shot owner sends one final report and awaits its acknowledgement.
      report: async () => undefined
    })
    return {
      ready: async () => {
        const configured = settings.get()
        if (!configured.financeDailyEnabled || configured.financeCollectorTransport === 'disabled')
          return true
        return await waitForCardCollectorNetwork({
          transport: configured.financeCollectorTransport,
          signal
        })
      },
      tick: () => daily!.tick(),
      vaultUnlocked: () => vault!.state() === 'unlocked',
      status: () => daily!.status(),
      stop: () => daily!.dispose(),
      dispose,
      flush: async () => {
        const status = daily!.status()
        return await reportCardSchedule(
          {
            enabled: status.enabled,
            hourKst: status.hourKst,
            phase: status.phase,
            runDate: status.runDate,
            startedAt: status.startedAt,
            finishedAt: status.finishedAt,
            gapDays: status.gapDays,
            results: (status.results.length
              ? status.results
              : CARD_DAILY_ISSUERS.map((issuer) => ({
                  issuer,
                  state: 'pending' as const,
                  reason: status.reason
                }))
            ).map((row) => ({
              issuer: row.issuer,
              state: row.state === 'running' ? 'pending' : row.state,
              reason: row.reason ?? status.reason,
              approvalComplete: row.approvalComplete,
              complete: row.complete,
              insertedRows: row.insertedRows,
              updatedRows: row.updatedRows
            }))
          },
          {
            tokenFile: settings.get().financeCollectorTokenFile,
            transport: settings.get().financeCollectorTransport,
            signal
          }
        )
      }
    }
  } catch {
    dispose()
    throw new Error('Card collector initialization unavailable')
  }
}

export async function runCardCollectorOnly(
  userData: string,
  signal?: AbortSignal
): Promise<CardCollectorState> {
  return await runCardCollectorLifecycle({
    open: (runSignal) => openCollectorResources(userData, runSignal),
    write: (status) => writeCardCollectorStatus(userData, status),
    signal
  })
}
