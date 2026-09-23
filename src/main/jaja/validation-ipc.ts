import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  IPC,
  type BookmarkTreeDto,
  type ChatDto,
  type ExtensionListDto,
  type IpcResult,
  type Layout,
  type VaultState
} from '../../shared/ipc'
import type { NewTabInitDto } from '../../shared/newtab'
import { parseSettings, type Settings } from '../../shared/settings'
import type { AuthState, WorkspaceDto } from '../../shared/sync'
import type { TabManager } from '../browser/tab-manager'
import { assertFromRenderer, settingsForSender } from '../ipc/sender'
import { isJajaValidation } from './validation'

export const VALIDATION_DISABLED =
  '검증 전용 모드에서는 소싱 계정과 탭 검증만 사용할 수 있습니다. AI·동기화·확장 설치·기존 로그인 정보 접근은 비활성화되어 있습니다.'

// Deliberately independent of the normal IPC bootstrap. Do not construct the AI,
// vault, sync, import, phone, scheduler or extension services in validation mode.
export function registerValidationIpc(win: BrowserWindow, tabs: TabManager): void {
  if (!isJajaValidation()) throw new Error('검증 전용 모드가 아닙니다.')
  let settings = parseSettings({ panelCollapsed: true, mouseGesturesEnabled: false })
  const registered = new Set<string>()
  const handle = <Args extends unknown[]>(
    channel: string,
    callback: (...args: Args) => unknown
  ): void => {
    registered.add(channel)
    ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<unknown>> => {
      try {
        assertFromRenderer(win, event.sender)
        return { ok: true, data: await callback(...(args as Args)) }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : VALIDATION_DISABLED }
      }
    })
  }
  tabs.setDefaultUrl('about:blank')
  tabs.setGestureConfig({
    enabled: false,
    language: settings.language,
    mapping: settings.mouseGestures
  })
  tabs.onChange((list) => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(IPC.tabUpdated, list)
    }
  })
  handle(IPC.tabList, () => tabs.listAll())
  handle(IPC.tabCreate, (options: { url?: string; profile?: string; mobile?: boolean }) =>
    tabs.create(options)
  )
  handle(IPC.tabClose, (id: string) => tabs.closeTarget(id))
  handle(IPC.tabActivate, (id: string) => tabs.focusTarget(id))
  handle(IPC.tabNavigate, (id: string, url: string) => tabs.navigate(id, url))
  handle(IPC.tabBack, (id: string) => tabs.back(id))
  handle(IPC.tabForward, (id: string) => tabs.forward(id))
  handle(IPC.tabReload, (id: string) => tabs.reload(id))
  handle(IPC.tabSetMobile, (id: string, mobile: boolean) => tabs.setMobile(id, mobile))
  handle(IPC.layoutSet, (layout: Layout) => tabs.setLayout(layout))
  handle(IPC.authState, (): AuthState => ({
    signedIn: false,
    configured: false,
    plan: 'free',
    deviceId: null,
    account: { configured: false, signedIn: false, needsSupabase: false }
  }))
  handle(IPC.vaultState, (): VaultState => 'uninitialized')
  handle(IPC.bookmarksTree, (): BookmarkTreeDto => ({ folders: [], links: [] }))
  handle(IPC.workspaceList, (): WorkspaceDto[] => [])
  handle(IPC.chatList, (): ChatDto[] => [])
  handle(IPC.extList, (): ExtensionListDto => ({ items: [], errors: [] }))

  registered.add(IPC.settingsGet)
  ipcMain.handle(IPC.settingsGet, (event): IpcResult<unknown> => ({
    ok: true,
    data: settingsForSender(settings, win, event.sender)
  }))
  const displayKeys = new Set([
    'sidebarWidth',
    'sidebarCollapsed',
    'sidebarSections',
    'panelWidth',
    'panelCollapsed',
    'language',
    'themeMode',
    'uiZoom'
  ])
  handle(IPC.settingsSet, (patch: Partial<Settings>) => {
    if (!patch || Object.keys(patch).some((key) => !displayKeys.has(key)))
      throw new Error(VALIDATION_DISABLED)
    settings = parseSettings({ ...settings, ...patch })
    return settings
  })
  registered.add(IPC.newTabInit)
  ipcMain.handle(IPC.newTabInit, (): NewTabInitDto => ({
    language: settings.language,
    bookmarks: []
  }))

  // Fail closed for present and future normal IPC features. Event-only channels
  // have no listeners, so they cannot create an alternate execution path.
  for (const channel of Object.values(IPC)) {
    if (registered.has(channel) || channel.startsWith('jaja:') || channel === IPC.faviconGet)
      continue
    ipcMain.handle(channel, (_event: IpcMainInvokeEvent): IpcResult<never> => ({
      ok: false,
      error: VALIDATION_DISABLED
    }))
  }
}
