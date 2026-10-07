export interface BrowserShortcutInput {
  type: string
  key: string
  code?: string
  control: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  isAutoRepeat?: boolean
  isComposing?: boolean
}

export type BrowserShortcut =
  'reload' | 'reloadWithoutCache' | 'find' | 'next' | 'previous' | 'closeFind'

/** Browser commands belong to this window, never to a global system shortcut. */
export function browserShortcut(input: BrowserShortcutInput): BrowserShortcut | null {
  if (input.type !== 'keyDown' || input.isAutoRepeat || input.isComposing || input.alt) return null
  const key = input.key.toLowerCase()
  const command = (input.control || input.meta) && !(input.control && input.meta)
  if (key === 'f5' && !input.meta)
    return input.shift || input.control ? 'reloadWithoutCache' : 'reload'
  if (command && (key === 'r' || input.code === 'KeyR'))
    return input.shift ? 'reloadWithoutCache' : 'reload'
  if (command && !input.shift && (key === 'f' || input.code === 'KeyF')) return 'find'
  if (!input.control && !input.meta) {
    if (key === 'f3') return input.shift ? 'previous' : 'next'
    if (key === 'escape' && !input.shift) return 'closeFind'
  }
  return null
}
