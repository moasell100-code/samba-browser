import type { Session, WebContents, BrowserWindowConstructorOptions } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ sessions: new Map<string, Session>(), seq: 0 }))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Contents extends EventEmitter {
    id = ++mock.seq
    url = 'about:blank'
    windowOpen?: (details: { url: string; disposition: string }) => unknown
    constructor(readonly session: Session) {
      super()
    }
    isDestroyed(): boolean {
      return false
    }
    isLoading(): boolean {
      return false
    }
    getURL(): string {
      return this.url
    }
    getTitle(): string {
      return this.url
    }
    getUserAgent(): string {
      return 'Chrome/142.0 Electron/39.0'
    }
    setUserAgent(): void {
      return undefined
    }
    send(): void {
      return undefined
    }
    close(): void {
      return undefined
    }
    setWindowOpenHandler(handler: typeof this.windowOpen): void {
      this.windowOpen = handler
    }
    async loadURL(url: string): Promise<void> {
      this.url = url
    }
  }
  class View {
    readonly webContents: Contents
    constructor(opts: { webPreferences: { session: Session } }) {
      this.webContents = new Contents(opts.webPreferences.session)
    }
    setBorderRadius(): void {
      return undefined
    }
    setBounds(): void {
      return undefined
    }
  }
  class Window extends EventEmitter {
    readonly webContents: Contents
    contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
    constructor(opts?: BrowserWindowConstructorOptions) {
      super()
      this.webContents = new Contents(opts?.webPreferences?.session as Session)
    }
    isDestroyed(): boolean {
      return false
    }
    getContentSize(): number[] {
      return [1000, 700]
    }
    getBounds(): object {
      return { x: 0, y: 0, width: 1000, height: 700 }
    }
    getSize(): number[] {
      return [400, 300]
    }
    setPosition(): void {
      return undefined
    }
  }
  return {
    app: { isPackaged: false },
    BrowserWindow: Window,
    WebContentsView: View,
    session: {
      fromPartition: (partition: string): Session => {
        let session = mock.sessions.get(partition)
        if (!session) {
          session = {
            registerPreloadScript: vi.fn(),
            setPermissionRequestHandler: vi.fn(),
            setPermissionCheckHandler: vi.fn(),
            on: vi.fn(),
            getUserAgent: () => 'Chrome/142.0 Electron/39.0',
            webRequest: { onBeforeSendHeaders: vi.fn() },
            cookies: { on: vi.fn(), set: vi.fn() }
          } as unknown as Session
          mock.sessions.set(partition, session)
        }
        return session
      }
    }
  }
})
vi.mock('../src/main/browser/internal-protocol', () => ({ attachInternalProtocol: vi.fn() }))
vi.mock('../src/main/browser/dialogs', () => ({
  installDialogHandler: vi.fn(),
  isAutomationActive: vi.fn()
}))
vi.mock('../src/main/favicon/service', () => ({ getFaviconService: () => null }))

import { BrowserWindow } from 'electron'
import { TabManager } from '../src/main/browser/tab-manager'
import { ClosedTabStack } from '../src/main/browser/gestures'

interface OpenResult {
  action: string
  overrideBrowserWindowOptions?: BrowserWindowConstructorOptions
}
function open(wc: WebContents, disposition: string): OpenResult {
  return (
    wc as unknown as {
      windowOpen: (details: { url: string; disposition: string }) => OpenResult
    }
  ).windowOpen({ url: 'https://shop.example/payment', disposition })
}

describe('account session tab routing', () => {
  beforeEach(() => mock.sessions.clear())

  it('명시적 계정 세션은 작업공간 변경과 같은 표시 이름에 영향받지 않는다', () => {
    const tabs = new TabManager(new BrowserWindow())
    tabs.setPartitionPrefix('persist:ws-first-')
    const a = tabs.createInSession({
      url: 'https://shop.example/',
      profile: '계정',
      partition: 'persist:jaja-a'
    })
    tabs.setPartitionPrefix('persist:ws-second-')
    const b = tabs.createInSession({
      url: 'https://shop.example/',
      profile: '계정',
      partition: 'persist:jaja-b'
    })
    const again = tabs.createInSession({ profile: '계정', partition: 'persist:jaja-a' })
    expect(tabs.get(a.id)?.view.webContents.session).not.toBe(
      tabs.get(b.id)?.view.webContents.session
    )
    expect(tabs.get(a.id)?.view.webContents.session).toBe(
      tabs.get(again.id)?.view.webContents.session
    )
    expect(mock.sessions.has('persist:ws-second-계정')).toBe(false)
    expect(a).not.toHaveProperty('partition')
  })

  it.each(['foreground-tab', 'background-tab'])(
    '작업공간 변경 뒤 %s 도 opener 의 세션을 유지한다',
    (disposition) => {
      const tabs = new TabManager(new BrowserWindow())
      tabs.setPartitionPrefix('persist:ws-original-')
      const original = tabs.create({ profile: 'account', url: 'https://shop.example/' })
      const opener = tabs.get(original.id)!.view.webContents
      tabs.setPartitionPrefix('persist:ws-other-')
      expect(open(opener, disposition).action).toBe('deny')
      const child = tabs.popupOf(original.id)!
      expect(child.view.webContents.session).toBe(opener.session)
      expect(mock.sessions.has('persist:ws-other-account')).toBe(false)
    }
  )

  it('결제 팝업과 팝업에서 연 인증창도 같은 세션을 명시한다', () => {
    const tabs = new TabManager(new BrowserWindow())
    const original = tabs.createInSession({ profile: 'account', partition: 'persist:jaja-payment' })
    const opener = tabs.get(original.id)!.view.webContents
    const result = open(opener, 'new-window')
    expect(result.overrideBrowserWindowOptions?.webPreferences?.session).toBe(opener.session)
    const popup = new BrowserWindow(result.overrideBrowserWindowOptions)
    opener.emit('did-create-window', popup, {})
    tabs.setPartitionPrefix('persist:ws-unrelated-')
    const auth = open(popup.webContents, 'new-window')
    expect(auth.overrideBrowserWindowOptions?.webPreferences?.session).toBe(opener.session)
  })

  it('일반 create 에 몰래 전달한 partition 은 무시하고 비영속 계정 세션은 거절한다', () => {
    const tabs = new TabManager(new BrowserWindow())
    const raw = { profile: 'normal', partition: 'persist:other-account' }
    tabs.create(raw)
    expect(mock.sessions.has('persist:normal')).toBe(true)
    expect(mock.sessions.has('persist:other-account')).toBe(false)
    expect(() => tabs.createInSession({ profile: 'account', partition: 'memory-only' })).toThrow(
      'persistent'
    )
  })

  it('닫은 계정 탭은 작업공간이 바뀌어도 원래 세션에서 복원한다', () => {
    const tabs = new TabManager(new BrowserWindow())
    const closed = new ClosedTabStack()
    tabs.onTabClosed((record) => closed.push(record))
    const original = tabs.createInSession({
      url: 'https://shop.example/order',
      profile: '계정',
      partition: 'persist:jaja-restore'
    })
    const originalSession = tabs.get(original.id)!.view.webContents.session
    tabs.close(original.id)
    tabs.setPartitionPrefix('persist:ws-switched-')
    const restored = tabs.restoreClosedTab(closed.pop()!)
    expect(tabs.get(restored.id)?.view.webContents.session).toBe(originalSession)
    expect(restored.url).toBe('https://shop.example/order')
    expect(mock.sessions.has('persist:ws-switched-계정')).toBe(false)
  })
})
