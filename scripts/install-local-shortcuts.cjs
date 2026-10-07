// Run with this repository's electron.exe. Repairs only this app's local shortcuts.
/* eslint-disable @typescript-eslint/no-require-imports -- Electron CLI loads this standalone installer as CommonJS. */
const { app, shell } = require('electron')
const { existsSync, mkdirSync, mkdtempSync, readdirSync } = require('node:fs')
const { join, resolve, normalize } = require('node:path')
const { tmpdir } = require('node:os')

const browserRoot = resolve(__dirname, '..')
const profile = mkdtempSync(join(tmpdir(), 'jaja-shortcut-setup-'))
app.setPath('userData', profile)
app.disableHardwareAcceleration()

app
  .whenReady()
  .then(() => {
    if (process.platform !== 'win32') throw new Error('Windows shortcuts required')
    const powershell = join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe'
    )
    const launcher = join(browserRoot, 'scripts/launch-local.ps1')
    const icon = join(browserRoot, 'resources/jaja-icon.ico')
    if (![powershell, launcher, icon, join(browserRoot, 'out/main/index.js')].every(existsSync))
      throw new Error('Local browser build is required')
    const options = {
      target: powershell,
      args: `-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File "${launcher}"`,
      cwd: browserRoot,
      description: 'JAJA browser',
      icon,
      iconIndex: 0,
      appUserModelId: 'com.samba.browser'
    }
    const desktop = join(app.getPath('desktop'), '자자 브라우저.lnk')
    const startMenu = join(app.getPath('appData'), 'Microsoft/Windows/Start Menu/Programs')
    mkdirSync(startMenu, { recursive: true })
    const targets = [desktop, join(startMenu, '자자 브라우저.lnk')]
    const pinned = join(
      app.getPath('appData'),
      'Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar'
    )
    if (existsSync(pinned)) {
      for (const name of readdirSync(pinned)) {
        if (!/\.lnk$/i.test(name)) continue
        const path = join(pinned, name)
        let existing
        try {
          existing = shell.readShortcutLink(path)
        } catch {
          continue // An unrelated broken shortcut must not block this repair.
        }
        // Keep the pinned filename so Explorer's saved reference remains valid.
        const target = normalize(existing.target).toLowerCase()
        const ownElectron =
          target.startsWith(normalize(join(browserRoot, 'node_modules')).toLowerCase() + '\\') &&
          target.endsWith('\\electron.exe') &&
          !existing.args.trim()
        const ownLauncher = existing.args.includes(launcher)
        if (ownElectron || ownLauncher) targets.push(path)
      }
    }
    for (const path of targets) {
      if (!shell.writeShortcutLink(path, existsSync(path) ? 'update' : 'create', options))
        throw new Error('Browser shortcut update failed')
      const check = shell.readShortcutLink(path)
      if (
        check.target.toLowerCase() !== powershell.toLowerCase() ||
        check.args !== options.args ||
        check.appUserModelId !== options.appUserModelId ||
        check.icon !== icon
      )
        throw new Error('Browser shortcut verification failed')
    }
    console.log(
      JSON.stringify({ shortcutsVerified: targets.length, pinnedRepaired: targets.length - 2 })
    )
    app.exit(0)
  })
  .catch(() => {
    console.error('JAJA browser shortcut setup failed')
    app.exit(1)
  })
