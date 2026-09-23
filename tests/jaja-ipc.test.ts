import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { TabManager } from '../src/main/browser/tab-manager'
import { registerJaja } from '../src/main/jaja/ipc'
import { IPC } from '../src/shared/ipc'

const state = vi.hoisted(() => ({
  failStore: false,
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>(),
  start: vi.fn(async () => {}),
  status: vi.fn(() => ({ connected: true })),
  connect: vi.fn(),
  pairStatus: vi.fn(() => ({ pending: true })),
  pairKey: vi.fn(async () => {})
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/synthetic-user-data' },
  safeStorage: {},
  ipcMain: {
    handle: (name: string, callback: (event: IpcMainInvokeEvent) => Promise<unknown>) =>
      state.handlers.set(name, callback)
  }
}))
vi.mock('../src/main/jaja/store', () => ({
  JAJA_BACKEND: 'https://api.ja-ja.org',
  JajaStore: class {
    constructor() {
      if (state.failStore) throw new Error('private file detail and secret')
    }
  }
}))
vi.mock('../src/main/jaja/manager', () => ({
  JajaManager: class {
    start = state.start
    status = state.status
    connect = state.connect
    pairStatus = state.pairStatus
    pairKey = state.pairKey
  }
}))

const win = {
  isDestroyed: () => false,
  webContents: { id: 1, isDestroyed: () => false, send: vi.fn() }
} as unknown as BrowserWindow
const renderer = { sender: { id: 1 } } as IpcMainInvokeEvent
const page = { sender: { id: 2 } } as IpcMainInvokeEvent

beforeEach(() => {
  vi.clearAllMocks()
  state.handlers.clear()
  state.failStore = false
})

describe('JAJA optional feature IPC registration', () => {
  it('starts the manager when the store is available', async () => {
    const manager = registerJaja(win, {} as TabManager)
    expect(manager).toBeDefined()
    expect(state.start).toHaveBeenCalledOnce()
    expect(await state.handlers.get(IPC.jajaStatus)!(renderer)).toEqual({
      ok: true,
      data: { connected: true }
    })
  })

  it('keeps registration alive with an explicit UI error if the connection store is unreadable', async () => {
    state.failStore = true
    expect(registerJaja(win, {} as TabManager)).toBeUndefined()
    expect(state.start).not.toHaveBeenCalled()
    const status = await state.handlers.get(IPC.jajaStatus)!(renderer)
    expect(status).toMatchObject({
      ok: true,
      data: {
        connected: false,
        connecting: false,
        accounts: [],
        error: expect.stringContaining('원본 설정 파일')
      }
    })
    expect(JSON.stringify(status)).not.toContain('private file detail')
    expect(await state.handlers.get(IPC.jajaConnect)!(renderer)).toMatchObject({
      ok: false,
      error: expect.stringContaining('원본 설정 파일')
    })
    expect(await state.handlers.get(IPC.jajaPairStatus)!(page)).toEqual({
      ok: true,
      data: { pending: false }
    })
    expect(await state.handlers.get(IPC.jajaPairKey)!(page, 'a'.repeat(64))).toMatchObject({
      ok: false
    })
  })

  it('still blocks untrusted page senders from UI channels in the failure state', async () => {
    state.failStore = true
    registerJaja(win, {} as TabManager)
    expect(await state.handlers.get(IPC.jajaStatus)!(page)).toMatchObject({
      ok: false,
      error: 'forbidden: renderer-only channel'
    })
    expect(await state.handlers.get(IPC.jajaConnect)!(page)).toMatchObject({ ok: false })
  })

  it('passes pairing sender and frame to the manager gate', async () => {
    registerJaja(win, {} as TabManager)
    await state.handlers.get(IPC.jajaPairStatus)!(page)
    expect(state.pairStatus).toHaveBeenCalledWith(page.sender, page.senderFrame)
    await state.handlers.get(IPC.jajaPairKey)!(page, 'a'.repeat(64))
    expect(state.pairKey).toHaveBeenCalledWith(page.sender, page.senderFrame, 'a'.repeat(64))
  })
})
