import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../src/shared/ipc'
import type { TabManager } from '../src/main/browser/tab-manager'
import { registerValidationIpc, VALIDATION_DISABLED } from '../src/main/jaja/validation-ipc'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, callback: (...args: unknown[]) => unknown) => {
      if (state.handlers.has(channel)) throw new Error('duplicate handler')
      state.handlers.set(channel, callback)
    }
  }
}))
const win = {
  isDestroyed: vi.fn(() => false),
  webContents: { id: 10, isDestroyed: vi.fn(() => false), send: vi.fn() }
} as unknown as BrowserWindow
const renderer = { sender: { id: 10 } } as IpcMainInvokeEvent
const page = { sender: { id: 20 } } as IpcMainInvokeEvent

function register(): {
  tabs: TabManager
  navigate: ReturnType<typeof vi.fn>
  onChange: ReturnType<typeof vi.fn>
} {
  const navigate = vi.fn()
  const onChange = vi.fn()
  const tabs = {
    setDefaultUrl: vi.fn(),
    setGestureConfig: vi.fn(),
    listAll: () => [{ id: 'synthetic-tab' }],
    onChange,
    navigate
  } as unknown as TabManager
  registerValidationIpc(win, tabs)
  return { tabs, navigate, onChange }
}

beforeEach(() => {
  state.handlers.clear()
  vi.clearAllMocks()
  vi.mocked(win.isDestroyed).mockReturnValue(false)
  vi.mocked(win.webContents.isDestroyed).mockReturnValue(false)
  vi.stubEnv('JAJA_VALIDATION', '1')
})
afterEach(() => vi.unstubAllEnvs())

describe('minimal validation IPC bootstrap', () => {
  it.each([
    IPC.agentRun,
    IPC.aiProviders,
    IPC.aiConnect,
    IPC.aiUsage,
    IPC.aiSwitchAccount,
    IPC.aiTestKey,
    IPC.syncNow,
    IPC.authSignIn,
    IPC.authSignInGoogle,
    IPC.authSaveSupabase,
    IPC.extLoad,
    IPC.extImportSources,
    IPC.extImportFrom,
    IPC.extInstallWebstore,
    IPC.importPasswords,
    IPC.vaultReveal,
    IPC.phoneInstallTools,
    IPC.translateRun,
    IPC.notifyTest,
    IPC.scheduleRunNow,
    IPC.harnessPutRules
  ])('rejects unrelated feature execution: %s', async (channel) => {
    register()
    expect(await state.handlers.get(channel)!(renderer, 'synthetic')).toEqual({
      ok: false,
      error: VALIDATION_DISABLED
    })
  })

  it('retains tab controls with renderer sender checks', async () => {
    const { navigate } = register()
    expect(await state.handlers.get(IPC.tabList)!(renderer)).toEqual({
      ok: true,
      data: [{ id: 'synthetic-tab' }]
    })
    await state.handlers.get(IPC.tabNavigate)!(renderer, 'synthetic-tab', 'about:blank')
    expect(navigate).toHaveBeenCalledWith('synthetic-tab', 'about:blank')
    navigate.mockClear()
    expect(
      await state.handlers.get(IPC.tabNavigate)!(page, 'synthetic-tab', 'about:blank')
    ).toMatchObject({
      ok: false
    })
    expect(navigate).not.toHaveBeenCalled()
  })

  it('publishes newly opened account tabs and subsequent selection changes to the UI', () => {
    const { onChange } = register()
    expect(onChange).toHaveBeenCalledOnce()
    const notify = onChange.mock.calls[0][0]
    const opened = [
      { id: 'account-a', title: '검증 계정 A', active: true },
      { id: 'account-b', title: '검증 계정 B', active: false }
    ]
    notify(opened)
    expect(win.webContents.send).toHaveBeenLastCalledWith(IPC.tabUpdated, opened)
    const switched = opened.map((tab) => ({ ...tab, active: tab.id === 'account-b' }))
    notify(switched)
    expect(win.webContents.send).toHaveBeenLastCalledWith(IPC.tabUpdated, switched)
    expect(win.webContents.send).toHaveBeenCalledTimes(2)
  })

  it.each(['window', 'renderer'])('does not publish tabs after the %s is destroyed', (target) => {
    const { onChange } = register()
    if (target === 'window') vi.mocked(win.isDestroyed).mockReturnValue(true)
    else vi.mocked(win.webContents.isDestroyed).mockReturnValue(true)
    onChange.mock.calls[0][0]([{ id: 'synthetic-tab' }])
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('provides local defaults without loading existing authentication or settings', async () => {
    register()
    expect(await state.handlers.get(IPC.authState)!(renderer)).toMatchObject({
      ok: true,
      data: { configured: false, signedIn: false, account: { configured: false } }
    })
    expect(await state.handlers.get(IPC.settingsGet)!(renderer)).toMatchObject({
      ok: true,
      data: { panelCollapsed: true, mouseGesturesEnabled: false }
    })
    expect(await state.handlers.get(IPC.settingsGet)!(page)).toEqual({
      ok: true,
      data: { language: 'ko' }
    })
    expect(await state.handlers.get(IPC.settingsSet)!(renderer, { bridgeEnabled: true })).toEqual({
      ok: false,
      error: VALIDATION_DISABLED
    })
    expect(
      await state.handlers.get(IPC.settingsSet)!(renderer, { panelCollapsed: false })
    ).toMatchObject({
      ok: true,
      data: { panelCollapsed: false }
    })
  })

  it('returns the actual preload DTO shapes consumed by browser and sidebar stores', async () => {
    register()
    expect(await state.handlers.get(IPC.extList)!(renderer)).toEqual({
      ok: true,
      data: { items: [], errors: [] }
    })
    expect(await state.handlers.get(IPC.bookmarksTree)!(renderer)).toEqual({
      ok: true,
      data: { folders: [], links: [] }
    })
    for (const channel of [IPC.workspaceList, IPC.chatList]) {
      expect(await state.handlers.get(channel)!(renderer)).toEqual({ ok: true, data: [] })
    }
    expect(await state.handlers.get(IPC.authState)!(renderer)).toEqual({
      ok: true,
      data: {
        signedIn: false,
        configured: false,
        plan: 'free',
        deviceId: null,
        account: { configured: false, signedIn: false, needsSupabase: false }
      }
    })
    expect(await state.handlers.get(IPC.vaultState)!(renderer)).toEqual({
      ok: true,
      data: 'uninitialized'
    })
    expect(await state.handlers.get(IPC.newTabInit)!(renderer)).toEqual({
      language: 'ko',
      bookmarks: []
    })
  })

  it('leaves JAJA and favicon IPC to their dedicated guarded registrations', () => {
    register()
    expect(state.handlers.has(IPC.jajaConnect)).toBe(false)
    expect(state.handlers.has(IPC.jajaPairKey)).toBe(false)
    expect(state.handlers.has(IPC.faviconGet)).toBe(false)
  })

  it('cannot replace the normal runtime by accident', () => {
    vi.stubEnv('JAJA_VALIDATION', '0')
    expect(() => register()).toThrow('검증 전용 모드가 아닙니다')
    expect(state.handlers.size).toBe(0)
  })
})
