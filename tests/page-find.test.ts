import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PageFindController, type FindTarget } from '../src/main/browser/page-find'
import type { PageFindEvent, PageFindRequest } from '../src/shared/page-find'
import type { BrowserShortcutInput } from '../src/main/browser/shortcuts'

class Contents extends EventEmitter {
  destroyed = false
  sequence = 0
  isDestroyed = () => this.destroyed
  findInPage = vi.fn((_query: string, _options: unknown) => ++this.sequence)
  stopFindInPage = vi.fn()
  focus = vi.fn()
  reload = vi.fn()
  reloadIgnoringCache = vi.fn()
  found(requestId: number, matches = 3, activeMatchOrdinal = 1): void {
    this.emit('found-in-page', {}, { requestId, matches, activeMatchOrdinal, finalUpdate: true })
  }
}
const keyboard = (key: string, mods: Partial<BrowserShortcutInput> = {}): BrowserShortcutInput => ({
  type: 'keyDown',
  key,
  control: false,
  alt: false,
  shift: false,
  meta: false,
  ...mods
})

describe('active-page find and keyboard controller', () => {
  let a: Contents, b: Contents, active: FindTarget | null, find: PageFindController
  let events: PageFindEvent[], focusRenderer: ReturnType<typeof vi.fn>
  beforeEach(() => {
    a = new Contents()
    b = new Contents()
    active = { id: 'a', contents: a }
    events = []
    focusRenderer = vi.fn()
    find = new PageFindController({
      active: () => active,
      emit: (event) => events.push(event),
      focusRenderer
    })
  })
  const request = (query: string, rest: Partial<PageFindRequest> = {}): PageFindRequest => ({
    tabId: 'a',
    sessionId: 1,
    query,
    forward: true,
    next: false,
    ...rest
  })

  it('opens the active page finder and refocuses repeated Ctrl+F without clearing the query', () => {
    expect(find.handleShortcut(keyboard('f', { control: true }))).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'opened', tabId: 'a', sessionId: 1, query: '' })
    find.search(request('needle'))
    find.open()
    expect(events.at(-1)).toEqual({ type: 'opened', tabId: 'a', sessionId: 1, query: 'needle' })
    expect(focusRenderer).toHaveBeenCalledTimes(2)
    expect(a.listenerCount('found-in-page')).toBe(1)
  })

  it('uses Electron 39 new-session semantics for initial, next, previous and edited terms', () => {
    find.open()
    find.search(request('needle'))
    expect(a.findInPage).toHaveBeenLastCalledWith('needle', { forward: true, findNext: true })
    find.next(true)
    expect(a.findInPage).toHaveBeenLastCalledWith('needle', { forward: true, findNext: false })
    find.next(false)
    expect(a.findInPage).toHaveBeenLastCalledWith('needle', { forward: false, findNext: false })
    find.search(request('changed', { next: true }))
    expect(a.findInPage).toHaveBeenLastCalledWith('changed', { forward: true, findNext: true })
  })

  it('ignores old query results and accepts only the current request', () => {
    find.open()
    find.search(request('old'))
    find.search(request('new'))
    const count = events.length
    a.found(1)
    expect(events).toHaveLength(count)
    a.found(2, 5, 2)
    expect(events.at(-1)).toEqual({
      type: 'result',
      tabId: 'a',
      sessionId: 1,
      query: 'new',
      matches: 5,
      activeMatchOrdinal: 2,
      finalUpdate: true
    })
  })

  it('clears an empty query, rejects late results, and restores focus on Escape', () => {
    find.open()
    find.search(request('needle'))
    find.search(request(''))
    expect(a.stopFindInPage).toHaveBeenCalledWith('clearSelection')
    const count = events.length
    a.found(1)
    expect(events).toHaveLength(count)
    expect(find.handleShortcut(keyboard('Escape'))).toBe(true)
    expect(a.focus).toHaveBeenCalledOnce()
    expect(a.listenerCount('found-in-page')).toBe(0)
    expect(find.handleShortcut(keyboard('Escape'))).toBe(false)
  })

  it('cleans up on tab changes and cannot close the next page with an old close request', () => {
    find.open()
    find.search(request('needle'))
    active = { id: 'b', contents: b }
    find.syncActive()
    find.open()
    expect(a.focus).not.toHaveBeenCalled()
    expect(a.listenerCount('found-in-page')).toBe(0)
    find.closeFor('a', 1)
    expect(find.isOpen).toBe(true)
    expect(() => find.search(request('stale'))).toThrow('no longer active')
    const count = events.length
    a.found(1)
    expect(events).toHaveLength(count)
  })

  it('main-frame navigation and destruction cancel find; iframe navigation does not', () => {
    find.open()
    find.search(request('needle'))
    a.emit('did-start-navigation', {}, 'https://frame.example', false, false)
    expect(find.isOpen).toBe(true)
    a.emit('did-start-navigation', {}, 'https://page.example', false, true)
    expect(find.isOpen).toBe(false)
    find.open()
    a.destroyed = true
    a.emit('destroyed')
    expect(find.isOpen).toBe(false)
    expect(a.focus).not.toHaveBeenCalled()
  })

  it('F5/Ctrl+R refresh only the active page once and Shift bypasses cache', () => {
    find.open()
    find.search(request('needle'))
    expect(find.handleShortcut(keyboard('F5'))).toBe(true)
    expect(a.reload).toHaveBeenCalledOnce()
    expect(find.isOpen).toBe(false)
    active = { id: 'b', contents: b }
    find.handleShortcut(keyboard('r', { control: true, shift: true }))
    expect(b.reloadIgnoringCache).toHaveBeenCalledOnce()
    expect(b.reload).not.toHaveBeenCalled()
    active = null
    expect(find.handleShortcut(keyboard('F5'))).toBe(false)
    expect(find.open()).toBe(false)
  })

  it('F3 uses the same search session and leaves empty find alone', () => {
    find.open()
    expect(find.handleShortcut(keyboard('F3'))).toBe(false)
    find.search(request('needle'))
    find.handleShortcut(keyboard('F3', { shift: true }))
    expect(a.findInPage).toHaveBeenLastCalledWith('needle', { forward: false, findNext: false })
  })

  it('lets renderer Escape reach capture/dialog UI and preserves renderer focus on view cleanup', () => {
    find.open()
    expect(find.handleShortcut(keyboard('Escape'), 'renderer')).toBe(false)
    expect(find.isOpen).toBe(true)
    find.closeFor('a', 1, false)
    expect(find.isOpen).toBe(false)
    expect(a.focus).not.toHaveBeenCalled()
  })

  it('ignores old same-tab search and close requests after reopening', () => {
    find.open()
    find.closeFor('a', 1)
    find.open()
    expect(events.at(-1)).toMatchObject({ type: 'opened', sessionId: 2 })
    find.closeFor('a', 1)
    expect(find.isOpen).toBe(true)
    expect(() => find.search(request('old'))).toThrow('no longer active')
    find.search(request('new', { sessionId: 2 }))
    expect(a.findInPage).toHaveBeenCalledOnce()
  })

  it.each([
    null,
    {},
    request('x'.repeat(513)),
    request('valid', { forward: 'true' as unknown as boolean }),
    request('valid', { next: undefined as unknown as boolean })
  ])('rejects malformed or oversized renderer requests without page actions', (input) => {
    find.open()
    expect(() => find.search(input as PageFindRequest)).toThrow('Invalid page search')
    expect(a.findInPage).not.toHaveBeenCalled()
  })
})
