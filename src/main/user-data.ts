import { win32 } from 'node:path'

/** Keep ordinary Windows development launches on the profile used by the local shortcut. */
export function browserUserDataPath(options: {
  platform: NodeJS.Platform
  isPackaged: boolean
  override?: string
  localAppData?: string
}): string | undefined {
  if (options.override) return options.override
  if (options.platform !== 'win32' || options.isPackaged) return undefined
  if (!options.localAppData || !win32.isAbsolute(options.localAppData)) {
    throw new Error('The Windows local application data directory is unavailable.')
  }
  return win32.join(options.localAppData, 'JAJA-Samba-Browser')
}
