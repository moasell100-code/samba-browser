import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { isHttpUrl } from '../shared/url'
import { isJajaValidation } from './jaja/validation'

// 메인 창 생성. 렌더러(React UI)가 전체를 덮고, 웹뷰는 그 위에 겹쳐 배치
export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: isJajaValidation() ? 'JAJA Browser · 검증 전용' : 'SAMBA Browser',
    // 작업표시줄·알트탭에 삼바 로고가 보이게(개발 모드에서도 electron 기본 아이콘 대신)
    icon: join(__dirname, '../../resources/icon.ico'),
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f5f5f7', symbolColor: '#1d1d1f', height: 38 },
    backgroundColor: '#f5f5f7',
    webPreferences: {
      preload: join(__dirname, '../preload/renderer.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  if (process.platform === 'win32' && !isJajaValidation()) {
    const powershell = join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe'
    )
    const launcher = join(app.getAppPath(), 'scripts/launch-local.ps1')
    win.setAppDetails({
      appId: 'com.samba.browser',
      appIconPath: join(__dirname, '../../resources/icon.ico'),
      appIconIndex: 0,
      relaunchDisplayName: '자자 브라우저',
      // The launcher restores the existing LocalAppData profile, including KeyMaster.
      relaunchCommand: app.isPackaged
        ? `"${process.execPath}"`
        : `"${powershell}" -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File "${launcher}"`
    })
  }
  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isJajaValidation()) return { action: 'deny' }
    // 외부 브라우저로 넘기는 건 http/https 만. file:/javascript: 등은 무시한다
    if (isHttpUrl(url)) void shell.openExternal(url)
    else console.warn(`외부 열기 차단: ${url}`)
    return { action: 'deny' }
  })
  return win
}

// DB 와 IPC 등록이 끝난 뒤 호출한다. 첫 렌더에서 보내는 조회도 반드시 처리할 수 있어야 한다.
export async function loadMainWindowRenderer(win: BrowserWindow): Promise<void> {
  if (!isJajaValidation() && is.dev && process.env['ELECTRON_RENDERER_URL']) {
    await win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}
