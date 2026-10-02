import { mkdir, writeFile, unlink, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Tab, TabManager } from '../browser/tab-manager'
import { isTabAlive } from '../browser/tab-manager'
import { CardNetworkObserver } from './card-network-observer'
import { CARD_HISTORY_URLS, inspectCardPage, issuerForCardUrl } from './card-page-diagnostics'
import { startCardDiagnosticsMcp, type CardDiagnosticIssuer } from './card-diagnostics-mcp'

const TTL_MS = 30 * 60 * 1000

/** Opt-in, one app lifetime only. Does not alter settings, vault access, or agent permissions. */
export async function startCardDiagnosticsRuntime(options: {
  tabs: TabManager
  tempDir: string
  sessionName: string
  isBusy: () => boolean
}): Promise<() => void> {
  if (!/^[a-z0-9-]{12,64}$/.test(options.sessionName)) throw new Error('Invalid diagnostic session')
  const dir = join(options.tempDir, `jaja-card-mcp-${options.sessionName}`)
  // A fresh directory prevents accidentally replacing a prior session's credentials.
  await mkdir(dir, { mode: 0o700 })
  const descriptor = join(dir, 'endpoint.json')
  const controller = new AbortController()
  const expiresAt = Date.now() + TTL_MS
  type Observation = {
    tab: Tab
    wc: Tab['view']['webContents']
    issuer: CardDiagnosticIssuer
    observer: CardNetworkObserver
    onDestroyed: () => void
  }
  const observed = new Map<string, Observation>()
  let closed = false
  let disposed = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  const assertAvailable = (): void => {
    if (
      closed ||
      disposed ||
      controller.signal.aborted ||
      Date.now() >= expiresAt ||
      options.isBusy()
    ) {
      throw new Error('Card diagnostics unavailable')
    }
  }
  const assertLiveTab = (tab: Tab): void => {
    assertAvailable()
    if (options.tabs.get(tab.id) !== tab || !isTabAlive(tab)) {
      throw new Error('Card tab changed')
    }
  }
  const assertTabContext = (tab: Tab, expectedUrl: string): void => {
    assertLiveTab(tab)
    if (tab.view.webContents.getURL() !== expectedUrl) throw new Error('Card tab changed')
  }
  const release = (entry: Observation): void => {
    // A destroyed WebContentsView may no longer expose webContents; keep its original emitter.
    try {
      entry.wc.removeListener('destroyed', entry.onDestroyed)
    } catch {
      /* already destroyed */
    }
    try {
      entry.observer.dispose()
    } catch {
      /* do not interrupt remaining cleanup */
    }
    if (observed.get(entry.tab.id) === entry) observed.delete(entry.tab.id)
  }
  const getTab = (id: string): Tab => {
    assertAvailable()
    const tab = options.tabs.get(id)
    if (!tab || !isTabAlive(tab) || !issuerForCardUrl(tab.view.webContents.getURL())) {
      throw new Error('Card tab unavailable')
    }
    return tab
  }
  const observe = async (
    tab: Tab,
    issuer: CardDiagnosticIssuer,
    expectedUrl: string
  ): Promise<void> => {
    assertTabContext(tab, expectedUrl)
    const previous = observed.get(tab.id)
    if (
      previous?.tab === tab &&
      previous.issuer === issuer &&
      previous.observer.snapshot().state === 'watching'
    )
      return
    if (previous) release(previous)
    const observer = new CardNetworkObserver(tab.view.webContents, issuer)
    const entry: Observation = {
      tab,
      wc: tab.view.webContents,
      issuer,
      observer,
      onDestroyed: () => release(entry)
    }
    // Register before Network.enable so stop() also owns pending observers.
    observed.set(tab.id, entry)
    tab.view.webContents.once('destroyed', entry.onDestroyed)
    try {
      await observer.start()
      assertTabContext(tab, expectedUrl)
      if (observed.get(tab.id) !== entry || observer.snapshot().state !== 'watching') {
        throw new Error('Card observation unavailable')
      }
    } catch {
      release(entry)
      throw new Error('Card observation unavailable')
    }
  }
  const backend = {
    isBusy: options.isBusy,
    list: () => {
      assertAvailable()
      return {
        expiresInSeconds: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
        tabs: options.tabs.list().flatMap((tab) => {
          const issuer = issuerForCardUrl(tab.url)
          const entry = observed.get(tab.id)
          const observing =
            entry?.issuer === issuer && entry?.observer.snapshot().state === 'watching'
          return issuer ? [{ tabId: tab.id, issuer, loading: tab.loading, observing }] : []
        })
      }
    },
    async openHistory(issuer: CardDiagnosticIssuer) {
      assertAvailable()
      const existing = options.tabs.list().find((tab) => issuerForCardUrl(tab.url) === issuer)
      const id = existing?.id ?? options.tabs.create({ url: 'about:blank' }).id
      const tab = options.tabs.get(id)!
      const initialUrl = tab.view.webContents.getURL()
      await observe(tab, issuer, initialUrl)
      assertTabContext(tab, initialUrl)
      // Only these constant history URLs can be navigated. No arbitrary URL or form submission.
      const load = tab.view.webContents.loadURL(CARD_HISTORY_URLS[issuer]).catch(() => undefined)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          load,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 20_000)
          })
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
      assertLiveTab(tab)
      const loadedUrl = tab.view.webContents.getURL()
      if (issuerForCardUrl(loadedUrl) !== issuer) throw new Error('Card tab changed')
      assertTabContext(tab, loadedUrl)
      const result = await inspectCardPage(tab)
      assertTabContext(tab, loadedUrl)
      return { tabId: id, ...result }
    },
    async inspect(id: string) {
      const tab = getTab(id)
      const initialUrl = tab.view.webContents.getURL()
      const issuer = issuerForCardUrl(initialUrl)!
      await observe(tab, issuer, initialUrl)
      assertTabContext(tab, initialUrl)
      const result = await inspectCardPage(tab)
      assertTabContext(tab, initialUrl)
      return { tabId: id, ...result }
    },
    requests(id: string) {
      const tab = getTab(id)
      const entry = observed.get(id)
      if (!entry) throw new Error('No observer')
      if (entry.tab !== tab || issuerForCardUrl(tab.view.webContents.getURL()) !== entry.issuer) {
        release(entry)
        throw new Error('Card tab changed')
      }
      return { tabId: id, ...entry.observer.snapshot() }
    },
    dispose() {
      disposed = true
      for (const entry of observed.values()) release(entry)
    }
  }
  const cleanup = async (): Promise<void> => {
    await unlink(descriptor).catch(() => undefined)
    await unlink(join(dir, 'client-session.json')).catch(() => undefined)
    await rmdir(dir).catch(() => undefined)
  }
  try {
    const bridge = await startCardDiagnosticsMcp(backend, controller.signal)
    const stop = (): void => {
      if (closed) return
      closed = true
      if (timeout) clearTimeout(timeout)
      controller.abort()
      void bridge.close().finally(cleanup)
    }
    timeout = setTimeout(stop, TTL_MS)
    timeout.unref()
    await writeFile(
      descriptor,
      JSON.stringify({
        url: bridge.url,
        bearerToken: bridge.bearerToken,
        expiresAt,
        pid: process.pid
      }),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    )
    return stop
  } catch {
    controller.abort()
    if (timeout) clearTimeout(timeout)
    await cleanup()
    throw new Error('Card diagnostics unavailable')
  }
}
