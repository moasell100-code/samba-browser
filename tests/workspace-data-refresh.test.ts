import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AccountDto,
  BookmarkTreeDto,
  IpcResult,
  VaultItemMeta,
  VaultState
} from '../src/shared/ipc'
import type { WorkspaceDto } from '../src/shared/sync'

vi.mock('../src/renderer/src/i18n', () => ({ default: { t: (key: string) => key } }))

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const account = (id: number): AccountDto => ({
  id,
  siteId: id,
  host: 'example.test',
  label: 'Synthetic',
  username: 'synthetic',
  isDefault: true,
  itemTypes: ['login'],
  urls: [],
  agentAccess: 'inherit',
  tags: []
})
const tree = (id: number): BookmarkTreeDto => ({
  folders: [],
  links: [{ id, title: 'Synthetic', url: 'https://example.test/' }]
})
const workspace = (id: number, active: boolean): WorkspaceDto => ({
  id,
  remoteId: null,
  name: `Workspace ${id}`,
  color: null,
  position: id,
  isActive: active
})
const ok = <T>(data: T): IpcResult<T> => ({ ok: true, data })

let bookmark: (typeof import('../src/renderer/src/stores/bookmarkStore'))['useBookmarkStore']
let vault: (typeof import('../src/renderer/src/stores/vaultStore'))['useVaultStore']
let workspaces: typeof import('../src/renderer/src/stores/workspaceStore')
let api: {
  bookmarks: { tree: ReturnType<typeof vi.fn> }
  workspace: { list: ReturnType<typeof vi.fn>; onChanged: ReturnType<typeof vi.fn> }
  vault: {
    state: ReturnType<typeof vi.fn>
    sites: ReturnType<typeof vi.fn>
    accounts: ReturnType<typeof vi.fn>
    items: ReturnType<typeof vi.fn>
    audit: ReturnType<typeof vi.fn>
  }
}

beforeEach(async () => {
  vi.resetModules()
  api = {
    bookmarks: { tree: vi.fn(async () => ok(tree(2))) },
    workspace: {
      list: vi.fn(async () => ok([workspace(1, false), workspace(2, true)])),
      onChanged: vi.fn(() => vi.fn())
    },
    vault: {
      state: vi.fn(async () => ok<VaultState>('unlocked')),
      sites: vi.fn(async () => ok([])),
      accounts: vi.fn(async () => ok([account(2)])),
      items: vi.fn(async () => ok([])),
      audit: vi.fn(async () => ok([]))
    }
  }
  Object.assign(globalThis, { window: { samba: api } })
  bookmark = (await import('../src/renderer/src/stores/bookmarkStore')).useBookmarkStore
  vault = (await import('../src/renderer/src/stores/vaultStore')).useVaultStore
  workspaces = await import('../src/renderer/src/stores/workspaceStore')
})

describe('workspace data refresh', () => {
  it('refreshes both lists through the App subscription without a mounted sidebar', async () => {
    bookmark.setState({ tree: tree(1) })
    vault.setState({ accounts: [account(1)], selectedAccountId: 1, query: 'old-filter' })
    workspaces.useWorkspaceStore.setState({ items: [workspace(1, true), workspace(2, false)] })
    const unsubscribe = workspaces.subscribeWorkspaceChanges()
    const listener = api.workspace.onChanged.mock.calls[0][0] as (w: WorkspaceDto) => void
    listener(workspace(2, true))
    expect(bookmark.getState().tree).toBeNull()
    expect(vault.getState().accounts).toEqual([])
    expect(vault.getState().selectedAccountId).toBeNull()
    expect(vault.getState().query).toBe('')
    await vi.waitFor(() => {
      expect(bookmark.getState().tree).toEqual(tree(2))
      expect(vault.getState().accounts).toEqual([account(2)])
      expect(vault.getState().loading).toBe(false)
    })
    unsubscribe()
    expect(api.workspace.onChanged.mock.results[0].value).toHaveBeenCalledOnce()
  })

  it('does not let a late bookmark response restore the previous workspace', async () => {
    const previous = deferred<IpcResult<BookmarkTreeDto>>()
    api.bookmarks.tree.mockImplementationOnce(() => previous.promise)
    const oldLoad = bookmark.getState().load()
    await bookmark.getState().reloadWorkspace()
    previous.resolve(ok(tree(1)))
    await oldLoad
    expect(bookmark.getState().tree).toEqual(tree(2))
  })

  it('rejects old account, item, and recent responses after switching workspace', async () => {
    const accounts = deferred<IpcResult<AccountDto[]>>()
    const items = deferred<IpcResult<VaultItemMeta[]>>()
    const audit = deferred<IpcResult<unknown[]>>()
    api.vault.accounts.mockImplementationOnce(() => accounts.promise)
    api.vault.items.mockImplementationOnce(() => items.promise)
    api.vault.audit.mockImplementationOnce(() => audit.promise)
    const pending = [
      vault.getState().loadAccounts(),
      vault.getState().loadItems(1),
      vault.getState().loadRecent()
    ]
    await vault.getState().reloadWorkspace()
    accounts.resolve(ok([account(1)]))
    items.resolve(
      ok([{ id: 1, accountId: 1, type: 'login', label: 'Old', sections: [], updatedAt: 1 }])
    )
    audit.resolve(ok([{ action: 'fill', accountId: 1 }]))
    await Promise.all(pending)
    expect(vault.getState().accounts).toEqual([account(2)])
    expect(vault.getState().itemsByAccount).toEqual({ global: [] })
    expect(vault.getState().recentAccountIds).toEqual([])
  })

  it('ignores an old vault-state response instead of clearing the new workspace list', async () => {
    const previous = deferred<IpcResult<VaultState>>()
    api.vault.state.mockImplementationOnce(() => previous.promise)
    const oldRefresh = vault.getState().refreshState()
    await vault.getState().reloadWorkspace()
    previous.resolve(ok('locked'))
    await oldRefresh
    expect(vault.getState().state).toBe('unlocked')
    expect(vault.getState().accounts).toEqual([account(2)])
  })

  it('reloads global items without remounting the open KeyMaster page', async () => {
    const previous = deferred<IpcResult<VaultItemMeta[]>>()
    const current: VaultItemMeta = {
      id: 2,
      accountId: null,
      type: 'note',
      label: 'Current',
      sections: [],
      updatedAt: 2
    }
    api.vault.items.mockImplementationOnce(() => previous.promise)
    api.vault.items.mockResolvedValueOnce(ok([current]))
    const oldLoad = vault.getState().loadItems(null)
    await vault.getState().reloadWorkspace()
    previous.resolve(ok([{ ...current, id: 1, label: 'Previous' }]))
    await oldLoad
    expect(api.vault.items).toHaveBeenLastCalledWith(null)
    expect(vault.getState().itemsByAccount.global).toEqual([current])
  })

  it('keeps a loaded list on IPC failure and exposes the failure', async () => {
    vault.setState({ accounts: [account(1)] })
    api.vault.accounts.mockResolvedValueOnce({ ok: false, error: 'Synthetic IPC unavailable' })
    await vault.getState().loadAccounts()
    expect(vault.getState().accounts).toEqual([account(1)])
    expect(vault.getState().error).toBe('Synthetic IPC unavailable')
  })
})
