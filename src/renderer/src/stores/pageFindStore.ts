import { create } from 'zustand'
import { PAGE_FIND_MAX_QUERY, type PageFindEvent } from '@shared/page-find'
import { useUiStore } from './uiStore'

interface PageFindState {
  open: boolean
  tabId: string | null
  sessionId: number | null
  query: string
  matches: number
  activeMatchOrdinal: number
  finalUpdate: boolean
  focusVersion: number
  error: boolean
  receive(event: PageFindEvent): void
  setQuery(query: string): Promise<void>
  next(forward: boolean): Promise<void>
  close(focusPage?: boolean): Promise<void>
}

let generation = 0

export const usePageFindStore = create<PageFindState>((set, get) => ({
  open: false,
  tabId: null,
  sessionId: null,
  query: '',
  matches: 0,
  activeMatchOrdinal: 0,
  finalUpdate: false,
  focusVersion: 0,
  error: false,
  receive: (event) => {
    if (event.type === 'opened') {
      ++generation
      useUiStore.getState().setView('browser')
      const same = get().tabId === event.tabId && get().sessionId === event.sessionId && get().open
      set({
        open: true,
        tabId: event.tabId,
        sessionId: event.sessionId,
        query: same ? get().query : event.query,
        focusVersion: get().focusVersion + 1,
        error: false,
        ...(same ? {} : { matches: 0, activeMatchOrdinal: 0, finalUpdate: false })
      })
    } else if (event.type === 'closed') {
      if (get().tabId === event.tabId && get().sessionId === event.sessionId) {
        ++generation
        set({
          open: false,
          tabId: null,
          sessionId: null,
          query: '',
          matches: 0,
          activeMatchOrdinal: 0,
          error: false
        })
      }
    } else if (
      get().open &&
      get().tabId === event.tabId &&
      get().sessionId === event.sessionId &&
      get().query === event.query
    ) {
      set({
        matches: event.matches,
        activeMatchOrdinal: event.activeMatchOrdinal,
        finalUpdate: event.finalUpdate,
        error: false
      })
    }
  },
  setQuery: async (query) => {
    const { tabId, sessionId, open } = get()
    if (!open || !tabId || sessionId === null || query.length > PAGE_FIND_MAX_QUERY) return
    const ticket = ++generation
    set({ query, matches: 0, activeMatchOrdinal: 0, finalUpdate: false, error: false })
    const result = await window.samba.pageFind.search({
      tabId,
      sessionId,
      query,
      forward: true,
      next: false
    })
    if (ticket === generation && get().tabId === tabId && get().query === query && !result.ok)
      set({ error: true })
  },
  next: async (forward) => {
    const { open, tabId, sessionId, query } = get()
    if (!open || !tabId || sessionId === null || !query) return
    const ticket = ++generation
    const result = await window.samba.pageFind.search({
      tabId,
      sessionId,
      query,
      forward,
      next: true
    })
    if (ticket === generation && get().tabId === tabId && get().query === query && !result.ok)
      set({ error: true })
  },
  close: async (focusPage = true) => {
    const { tabId, sessionId } = get()
    if (!tabId || sessionId === null) return
    ++generation
    // Hide immediately; a queued close for this page cannot close a newly opened page search.
    set({
      open: false,
      tabId: null,
      sessionId: null,
      query: '',
      matches: 0,
      activeMatchOrdinal: 0,
      error: false
    })
    await window.samba.pageFind.close(tabId, sessionId, focusPage)
  }
}))

export function subscribePageFind(): () => void {
  return window.samba.pageFind.onChanged((event) => usePageFindStore.getState().receive(event))
}
