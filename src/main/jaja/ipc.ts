import { app, ipcMain, safeStorage, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { IPC, type IpcResult } from '../../shared/ipc'
import type { JajaStatus } from '../../shared/jaja'
import type { TabManager } from '../browser/tab-manager'
import { assertFromRenderer } from '../ipc/sender'
import { JajaManager } from './manager'
import { JAJA_BACKEND, JajaStore } from './store'

export function registerJaja(win: BrowserWindow, tabs: TabManager): JajaManager | undefined {
  let manager: JajaManager | undefined
  const unavailable =
    '자자 연결 설정을 열지 못했습니다. 원본 설정 파일을 확인한 뒤 브라우저를 다시 시작하세요.'
  try {
    manager = new JajaManager(
      new JajaStore(join(app.getPath('userData'), 'jaja-connection.json'), safeStorage),
      tabs,
      (status) => {
        if (!win.isDestroyed()) win.webContents.send(IPC.jajaChanged, status)
      }
    )
  } catch {
    // A damaged optional connection file must not close the browser or overwrite the original.
    // Do not log raw errors: filesystem and cipher messages can contain private details.
  }
  const required = (): JajaManager => {
    if (!manager) throw new Error(unavailable)
    return manager
  }
  const status = (): JajaStatus =>
    manager?.status() ?? {
      connected: false,
      connecting: false,
      backendOrigin: JAJA_BACKEND,
      hostId: '',
      accounts: [],
      error: unavailable
    }
  const handle = <Args extends unknown[]>(
    channel: string,
    callback: (...args: Args) => unknown
  ): void => {
    ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<unknown>> => {
      try {
        assertFromRenderer(win, event.sender)
        return { ok: true, data: await callback(...(args as Args)) }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : '자자 요청 실패' }
      }
    })
  }
  handle(IPC.jajaStatus, status)
  handle(IPC.jajaConnect, (origin?: string) => required().connect(origin))
  handle(IPC.jajaDisconnect, () => required().disconnect())
  handle(IPC.jajaRefresh, () => required().refresh())
  handle(IPC.jajaOpen, (id: string) => required().open(id))
  handle(IPC.jajaCheck, (id: string) => required().check(id))
  handle(IPC.jajaActivate, (id: string) => required().action(id, 'activate'))
  handle(IPC.jajaPause, (id: string) => required().action(id, 'pause'))
  handle(IPC.jajaRelease, (id: string) => required().action(id, 'release'))
  handle(IPC.jajaAutoLogin, (id: string, enabled: boolean) => required().setAutoLogin(id, enabled))
  const pair = (
    channel: string,
    callback: (event: IpcMainInvokeEvent, key?: unknown) => unknown
  ): void => {
    ipcMain.handle(channel, async (event, key): Promise<IpcResult<unknown>> => {
      try {
        return { ok: true, data: await callback(event, key) }
      } catch {
        return { ok: false, error: '자자 연결을 완료하지 못했습니다. 연결 상태를 확인하세요.' }
      }
    })
  }
  pair(
    IPC.jajaPairStatus,
    (event) => manager?.pairStatus(event.sender, event.senderFrame) ?? { pending: false }
  )
  pair(IPC.jajaPairKey, (event, key) => required().pairKey(event.sender, event.senderFrame, key))
  if (manager) void manager.start()
  return manager
}
