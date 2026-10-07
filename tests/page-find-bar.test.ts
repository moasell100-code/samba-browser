// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, getByLabelText, getByRole, queryByRole } from '@testing-library/dom'
import ko from '../src/renderer/src/i18n/ko.json'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ko.pageFind[key.split('.')[1] as keyof typeof ko.pageFind]
  })
}))
vi.mock('../src/renderer/src/stores/uiStore', () => ({
  useUiStore: { getState: () => ({ setView: vi.fn() }) }
}))
import { FindBar } from '../src/renderer/src/components/browser/FindBar'
import { usePageFindStore } from '../src/renderer/src/stores/pageFindStore'

let root: Root, host: HTMLDivElement
let search: ReturnType<typeof vi.fn>, close: ReturnType<typeof vi.fn>
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  search = vi.fn(async () => ({ ok: true, data: undefined }))
  close = vi.fn(async () => ({ ok: true, data: undefined }))
  Object.assign(window, { samba: { pageFind: { search, close } } })
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
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(createElement(FindBar)))
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})
async function open(): Promise<HTMLInputElement> {
  await act(async () =>
    usePageFindStore.getState().receive({ type: 'opened', tabId: 'a', sessionId: 1, query: '' })
  )
  return getByRole(host, 'textbox', { name: '페이지에서 찾기' }) as HTMLInputElement
}

describe('find bar keyboard and native-view-safe layout', () => {
  it('opens as a layout row with focused/selectable input and accessible results', async () => {
    expect(queryByRole(host, 'search')).toBeNull()
    const input = await open()
    expect(document.activeElement).toBe(input)
    expect(input.maxLength).toBe(512)
    expect(getByRole(host, 'search').className).toContain('shrink-0')
    await act(async () => fireEvent.change(input, { target: { value: 'needle' } }))
    await act(async () =>
      usePageFindStore
        .getState()
        .receive({
          type: 'result',
          tabId: 'a',
          sessionId: 1,
          query: 'needle',
          matches: 3,
          activeMatchOrdinal: 2,
          finalUpdate: true
        })
    )
    expect(getByLabelText(host, '페이지 찾기 결과').textContent).toBe('2 / 3')
    expect(getByLabelText(host, '페이지 찾기 결과').getAttribute('aria-live')).toBe('polite')
    await act(async () =>
      usePageFindStore
        .getState()
        .receive({ type: 'opened', tabId: 'a', sessionId: 1, query: 'needle' })
    )
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(6)
  })

  it('uses Enter and Shift+Enter for next/previous, and Escape to close', async () => {
    const input = await open()
    await act(async () => fireEvent.change(input, { target: { value: 'needle' } }))
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }))
    expect(search).toHaveBeenLastCalledWith({
      tabId: 'a',
      sessionId: 1,
      query: 'needle',
      forward: true,
      next: true
    })
    await act(async () => fireEvent.keyDown(input, { key: 'Enter', shiftKey: true }))
    expect(search).toHaveBeenLastCalledWith({
      tabId: 'a',
      sessionId: 1,
      query: 'needle',
      forward: false,
      next: true
    })
    await act(async () => fireEvent.keyDown(input, { key: 'Escape' }))
    expect(close).toHaveBeenCalledWith('a', 1, true)
    expect(queryByRole(host, 'search')).toBeNull()
  })

  it('leaves Korean IME composition Enter/Escape alone', async () => {
    const input = await open()
    await act(async () => fireEvent.change(input, { target: { value: '한글' } }))
    search.mockClear()
    await act(async () => fireEvent.keyDown(input, { key: 'Enter', isComposing: true }))
    await act(async () => fireEvent.keyDown(input, { key: 'Escape', keyCode: 229 }))
    expect(search).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    expect(queryByRole(host, 'search')).not.toBeNull()
  })
})
