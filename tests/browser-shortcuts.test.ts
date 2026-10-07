import { describe, expect, it } from 'vitest'
import { browserShortcut, type BrowserShortcutInput } from '../src/main/browser/shortcuts'
import { workspaceShortcutIndex } from '../src/main/workspace/shortcut'

const key = (key: string, mods: Partial<BrowserShortcutInput> = {}): BrowserShortcutInput => ({
  type: 'keyDown',
  key,
  control: false,
  alt: false,
  shift: false,
  meta: false,
  ...mods
})

describe('window-local browser shortcut matching', () => {
  it.each([
    [key('F5'), 'reload'],
    [key('F5', { shift: true }), 'reloadWithoutCache'],
    [key('F5', { control: true }), 'reloadWithoutCache'],
    [key('r', { control: true }), 'reload'],
    [key('R', { meta: true }), 'reload'],
    [key('r', { control: true, shift: true }), 'reloadWithoutCache'],
    [key('f', { control: true }), 'find'],
    [key('F', { meta: true }), 'find'],
    [key('ㅁ', { code: 'KeyF', control: true }), 'find'],
    [key('F3'), 'next'],
    [key('F3', { shift: true }), 'previous'],
    [key('Escape'), 'closeFind']
  ])('maps %j to %s', (input, command) =>
    expect(browserShortcut(input as BrowserShortcutInput)).toBe(command)
  )

  it.each([
    key('f'),
    key('f', { control: true, alt: true }),
    key('f', { control: true, shift: true }),
    key('f', { control: true, meta: true }),
    key('F5', { meta: true }),
    key('F3', { alt: true }),
    key('Escape', { control: true }),
    key('F5', { type: 'keyUp' }),
    key('F5', { isAutoRepeat: true }),
    key('Escape', { isComposing: true }),
    key('Enter')
  ])('leaves unrelated keys and repeats alone: %j', (input) =>
    expect(browserShortcut(input)).toBeNull()
  )

  it('does not steal existing workspace or capture key chords', () => {
    const workspace = key('2', { control: true, alt: true })
    expect(workspaceShortcutIndex(workspace)).toBe(2)
    expect(browserShortcut(workspace)).toBeNull()
    expect(browserShortcut(key('2', { alt: true }))).toBeNull()
  })
})
