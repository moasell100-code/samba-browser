import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PageFindEvent } from '../src/shared/page-find'

const setView = vi.hoisted(() => vi.fn())
vi.mock('../src/renderer/src/stores/uiStore', () => ({
  useUiStore: { getState: () => ({ setView }) }
}))
import { subscribePageFind, usePageFindStore } from '../src/renderer/src/stores/pageFindStore'

let search: ReturnType<typeof vi.fn>, close: ReturnType<typeof vi.fn>
beforeEach(() => {
  search = vi.fn(async () => ({ ok: true, data: undefined }))
  close = vi.fn(async () => ({ ok: true, data: undefined }))
  vi.stubGlobal('window', { samba: { pageFind: { search, close } } })
  usePageFindStore.setState({
    open: false,
    tabId: null,
    sessionId: null,
    query: '',
    matches: 0,
    activeMatchOrdinal: 0,
    error: false,
    focusVersion: 0
  })
  setView.mockClear()
})
const open = (tabId = 'a'): void =>
  usePageFindStore.getState().receive({ type: 'opened', tabId, sessionId: 1, query: '' })
const result = (tabId: string, query: string, matches = 3): PageFindEvent => ({
  type: 'result',
  tabId,
  sessionId: 1,
  query,
  matches,
  activeMatchOrdinal: 1,
  finalUpdate: true
})

describe('page find renderer state', () => {
  it('switches to the browser, preserves typed text on refocus and increments the focus token', async () => {
    open()
    await usePageFindStore.getState().setQuery('needle')
    usePageFindStore.getState().receive({ type: 'opened', tabId: 'a', sessionId: 1, query: 'old' })
    expect(setView).toHaveBeenLastCalledWith('browser')
    expect(usePageFindStore.getState()).toMatchObject({
      open: true,
      query: 'needle',
      focusVersion: 2
    })
  })

  it('ignores results for old terms and pages, and clears on matching close only', async () => {
    open()
    await usePageFindStore.getState().setQuery('new')
    usePageFindStore.getState().receive(result('a', 'old', 9))
    usePageFindStore.getState().receive(result('b', 'new', 9))
    expect(usePageFindStore.getState().matches).toBe(0)
    usePageFindStore.getState().receive(result('a', 'new'))
    expect(usePageFindStore.getState().matches).toBe(3)
    usePageFindStore.getState().receive({ type: 'closed', tabId: 'b', sessionId: 1 })
    expect(usePageFindStore.getState().open).toBe(true)
    usePageFindStore.getState().receive({ type: 'closed', tabId: 'a', sessionId: 1 })
    expect(usePageFindStore.getState()).toMatchObject({ open: false, query: '', matches: 0 })
  })

  it('sends explicit initial/next/back requests, and bounds query length', async () => {
    open()
    await usePageFindStore.getState().setQuery('needle')
    expect(search).toHaveBeenLastCalledWith({
      tabId: 'a',
      sessionId: 1,
      query: 'needle',
      forward: true,
      next: false
    })
    await usePageFindStore.getState().next(false)
    expect(search).toHaveBeenLastCalledWith({
      tabId: 'a',
      sessionId: 1,
      query: 'needle',
      forward: false,
      next: true
    })
    const calls = search.mock.calls.length
    await usePageFindStore.getState().setQuery('x'.repeat(513))
    expect(search).toHaveBeenCalledTimes(calls)
  })

  it('hides immediately on close and ignores an old failed IPC after closing/reopening', async () => {
    let resolve!: (value: unknown) => void
    search.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    open()
    const pending = usePageFindStore.getState().setQuery('needle')
    await usePageFindStore.getState().close()
    expect(close).toHaveBeenCalledWith('a', 1, true)
    expect(usePageFindStore.getState().open).toBe(false)
    open()
    await usePageFindStore.getState().setQuery('needle')
    resolve({ ok: false, error: 'old failure' })
    await pending
    expect(usePageFindStore.getState().error).toBe(false)
  })

  it('subscribes once and returns the IPC unsubscriber', () => {
    const unsubscribe = vi.fn()
    let receive!: (event: PageFindEvent) => void
    window.samba.pageFind.onChanged = (callback) => {
      receive = callback
      return unsubscribe
    }
    const dispose = subscribePageFind()
    receive({ type: 'opened', tabId: 'a', sessionId: 1, query: '' })
    expect(usePageFindStore.getState().open).toBe(true)
    dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('does not allow an old same-page session event to hide or update a new search', async () => {
    open()
    await usePageFindStore.getState().close()
    usePageFindStore.getState().receive({ type: 'opened', tabId: 'a', sessionId: 2, query: '' })
    await usePageFindStore.getState().setQuery('needle')
    usePageFindStore.getState().receive(result('a', 'needle'))
    usePageFindStore.getState().receive({ type: 'closed', tabId: 'a', sessionId: 1 })
    expect(usePageFindStore.getState()).toMatchObject({ open: true, sessionId: 2, matches: 0 })
    await usePageFindStore.getState().close(false)
    expect(close).toHaveBeenLastCalledWith('a', 2, false)
  })
})
