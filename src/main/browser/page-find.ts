import {
  PAGE_FIND_MAX_QUERY,
  type PageFindEvent,
  type PageFindRequest
} from '../../shared/page-find'
import { browserShortcut, type BrowserShortcutInput } from './shortcuts'

interface FindResult {
  requestId: number
  activeMatchOrdinal: number
  matches: number
  finalUpdate: boolean
}

export interface FindContents {
  isDestroyed(): boolean
  findInPage(query: string, options: { forward: boolean; findNext: boolean }): number
  stopFindInPage(action: 'clearSelection'): void
  focus(): void
  reload(): void
  reloadIgnoringCache(): void
  on(event: string, listener: (...args: any[]) => void): unknown
  removeListener(event: string, listener: (...args: any[]) => void): unknown
}

export interface FindTarget {
  id: string
  contents: FindContents
}

interface FindDeps {
  active(): FindTarget | null
  emit(event: PageFindEvent): void
  focusRenderer(): void
}

/** One active page search; late results from old terms or detached pages are discarded. */
export class PageFindController {
  private target: FindTarget | null = null
  private query = ''
  private requestId: number | null = null
  private sessionId = 0
  private detach: (() => void) | null = null

  constructor(private deps: FindDeps) {}

  get isOpen(): boolean {
    return this.target !== null
  }

  open(): boolean {
    const active = this.deps.active()
    if (!active || active.contents.isDestroyed()) return false
    if (this.target?.id !== active.id) {
      this.close(false)
      this.target = active
      ++this.sessionId
      const result = (_event: unknown, found: FindResult): void => {
        if (this.target !== active || found.requestId !== this.requestId) return
        if (this.deps.active()?.id !== active.id) return
        this.deps.emit({
          type: 'result',
          tabId: active.id,
          sessionId: this.sessionId,
          query: this.query,
          activeMatchOrdinal: found.activeMatchOrdinal,
          matches: found.matches,
          finalUpdate: found.finalUpdate
        })
      }
      const navigation = (
        _event: unknown,
        _url: string,
        _inPlace: boolean,
        mainFrame: boolean
      ): void => {
        if (mainFrame !== false) this.close(false)
      }
      const destroyed = (): void => this.close(false)
      active.contents.on('found-in-page', result)
      active.contents.on('did-start-navigation', navigation)
      active.contents.on('destroyed', destroyed)
      this.detach = () => {
        active.contents.removeListener('found-in-page', result)
        active.contents.removeListener('did-start-navigation', navigation)
        active.contents.removeListener('destroyed', destroyed)
      }
    }
    this.deps.emit({
      type: 'opened',
      tabId: active.id,
      sessionId: this.sessionId,
      query: this.query
    })
    this.deps.focusRenderer()
    return true
  }

  search(input: PageFindRequest): void {
    if (
      !input ||
      typeof input.tabId !== 'string' ||
      !Number.isSafeInteger(input.sessionId) ||
      typeof input.query !== 'string' ||
      input.query.length > PAGE_FIND_MAX_QUERY ||
      typeof input.forward !== 'boolean' ||
      typeof input.next !== 'boolean'
    )
      throw new Error('Invalid page search')
    const target = this.target
    if (
      !target ||
      input.tabId !== target.id ||
      input.sessionId !== this.sessionId ||
      this.deps.active()?.id !== target.id ||
      target.contents.isDestroyed()
    )
      throw new Error('Page search is no longer active')
    const next = input.next && this.query === input.query && this.requestId !== null
    this.query = input.query
    this.requestId = null
    if (!input.query) {
      target.contents.stopFindInPage('clearSelection')
      this.deps.emit({
        type: 'result',
        tabId: target.id,
        sessionId: this.sessionId,
        query: '',
        activeMatchOrdinal: 0,
        matches: 0,
        finalUpdate: true
      })
      return
    }
    // Electron names this option findNext, but true starts a NEW session;
    // follow-up next/previous requests must pass false (Electron 39's API contract).
    this.requestId = target.contents.findInPage(input.query, {
      forward: input.forward,
      findNext: !next
    })
  }

  next(forward: boolean): boolean {
    if (!this.target || !this.query) return false
    this.search({
      tabId: this.target.id,
      sessionId: this.sessionId,
      query: this.query,
      forward,
      next: true
    })
    return true
  }

  close(focusPage = true): void {
    const target = this.target
    if (!target) return
    this.target = null
    this.query = ''
    this.requestId = null
    this.detach?.()
    this.detach = null
    if (!target.contents.isDestroyed()) {
      target.contents.stopFindInPage('clearSelection')
      if (focusPage && this.deps.active()?.id === target.id) target.contents.focus()
    }
    this.deps.emit({ type: 'closed', tabId: target.id, sessionId: this.sessionId })
  }

  closeFor(tabId: string, sessionId: number, focusPage = true): void {
    if (
      typeof tabId !== 'string' ||
      !Number.isSafeInteger(sessionId) ||
      typeof focusPage !== 'boolean'
    )
      throw new Error('Invalid page search target')
    if (this.target?.id === tabId && this.sessionId === sessionId) this.close(focusPage)
  }

  syncActive(): void {
    if (
      this.target &&
      (this.deps.active()?.id !== this.target.id || this.target.contents.isDestroyed())
    )
      this.close(false)
  }

  handleShortcut(input: BrowserShortcutInput, source: 'page' | 'renderer' = 'page'): boolean {
    this.syncActive()
    const action = browserShortcut(input)
    if (action === 'find') return this.open()
    if (action === 'closeFind') {
      // Renderer Escape belongs to its focused UI (finder, capture overlay, dialogs).
      // The finder row handles its own Escape; only page focus is intercepted here.
      if (source === 'renderer') return false
      if (!this.isOpen) return false
      this.close()
      return true
    }
    if (action === 'next' || action === 'previous') return this.next(action === 'next')
    if (action === 'reload' || action === 'reloadWithoutCache') {
      const active = this.deps.active()
      if (!active || active.contents.isDestroyed()) return false
      this.close(false)
      if (action === 'reloadWithoutCache') active.contents.reloadIgnoringCache()
      else active.contents.reload()
      return true
    }
    return false
  }
}
