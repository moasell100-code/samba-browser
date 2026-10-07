import type { BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc'
import type { TabManager } from './tab-manager'
import { PageFindController } from './page-find'

export function createPageFindController(win: BrowserWindow, tabs: TabManager): PageFindController {
  const find = new PageFindController({
    active: () => {
      const tab = tabs.active()
      return tab ? { id: tab.id, contents: tab.view.webContents } : null
    },
    emit: (event) => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed())
        win.webContents.send(IPC.pageFindChanged, event)
    },
    focusRenderer: () => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.focus()
    }
  })
  // This hook runs before activeId changes: close the old search without stealing focus.
  tabs.onActivated(() => find.close(false))
  win.once('closed', () => find.close(false))
  return find
}
