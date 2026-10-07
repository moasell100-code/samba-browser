import { win32 } from 'node:path'

/** Keep all Windows launches outside package-virtualized AppData. */
export function browserUserDataPath(options: {
  platform: NodeJS.Platform
  isPackaged: boolean
  override?: string
  userProfile?: string
}): string | undefined {
  if (options.override) return options.override
  if (options.platform !== 'win32') return undefined
  const home = options.userProfile
  if (!home?.trim() || !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/.test(home)) {
    throw new Error('The absolute Windows user home directory is unavailable.')
  }
  return win32.join(home, '.jaja-browser')
}
