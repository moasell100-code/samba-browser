// Built-app regression: extension webRequest + browser-process fetch used to crash Electron.
// Run after pnpm build with electron scripts/test-browser-request-runtime.cjs.
// Uses a new temporary profile, a synthetic extension and loopback HTTP only.
const { app, BrowserWindow, session, net } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jaja-request-runtime-'))
process.env.SAMBA_USER_DATA = profile
delete process.env.SAMBA_CARD_MCP_SESSION
delete process.env.SAMBA_E2E_LOGIN
delete process.env.ELECTRON_RENDERER_URL
app.setAppPath(root)
fs.writeFileSync(
  path.join(profile, 'config.json'),
  JSON.stringify({ newTabUrl: 'blank', financeDailyEnabled: false, phoneAutoReconnect: false })
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let server
let win
let extensionReady = false
let completed = false
let stage = 'startup'
const deadline = setTimeout(() => {
  console.error(JSON.stringify({ result: 'BROWSER_REQUEST_RUNTIME_FAIL', stage: 'timeout' }))
  app.exit(1)
}, 40000)
app.on('browser-window-created', (_event, created) => {
  // The real UI and preload still run; keep this isolated test off the desktop.
  created.on('show', () => created.hide())
})

async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error('condition unavailable')
}

async function tabsCall(method, ...args) {
  const result = await win.webContents.executeJavaScript(
    `window.samba.tabs.${method}(...${JSON.stringify(args)})`
  )
  assert.equal(result.ok, true)
  return result.data
}

async function run() {
  server = http.createServer((req, res) => {
    if (req.url === '/extension-ready') extensionReady = true
    if (req.url === '/fixture') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>Request fixture</title><p>Local request fixture</p>')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('synthetic-response')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  const extensionDir = path.join(profile, 'synthetic-extension')
  fs.mkdirSync(extensionDir)
  fs.writeFileSync(
    path.join(extensionDir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Synthetic request observer',
      version: '1.0',
      permissions: ['webRequest'],
      host_permissions: ['http://127.0.0.1/*'],
      background: { service_worker: 'background.js' }
    })
  )
  fs.writeFileSync(
    path.join(extensionDir, 'background.js'),
    `chrome.webRequest.onBeforeSendHeaders.addListener(() => {}, { urls: ['http://127.0.0.1/*'] });\nfetch(${JSON.stringify(origin + '/extension-ready')});\n`
  )

  // Load actual app startup; this test never installs or replaces its request dispatcher.
  require(path.join(root, 'out/main/index.js'))
  await app.whenReady()
  win = await waitFor(() => BrowserWindow.getAllWindows()[0])
  await waitFor(async () => {
    try {
      return await win.webContents.executeJavaScript('Boolean(window.samba?.tabs)')
    } catch {
      return false
    }
  })

  stage = 'extension'
  const extension = await session.defaultSession.extensions.loadExtension(extensionDir)
  await waitFor(() => extensionReady)
  assert.ok(
    session.defaultSession.extensions.getAllExtensions().some((item) => item.id === extension.id)
  )

  // Previously exited natively before resolving: default-session fetch had no frame host.
  stage = 'browser-fetch'
  const response = await net.fetch(origin + '/request')
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'synthetic-response')

  stage = 'tab-navigation'
  const tab = await tabsCall('create', { url: 'about:blank' })
  await tabsCall('navigate', tab.id, origin + '/fixture')
  await waitFor(async () =>
    (await tabsCall('list')).some(
      (item) => item.id === tab.id && item.url === origin + '/fixture' && !item.loading
    )
  )
  await sleep(1000)
  assert.equal(win.isDestroyed(), false)
  const repeated = await net.fetch(origin + '/request-again')
  assert.equal(repeated.status, 200)
  assert.equal(await repeated.text(), 'synthetic-response')
  await tabsCall('close', tab.id)
  session.defaultSession.extensions.removeExtension(extension.id)
  completed = true
  console.log(
    JSON.stringify({
      result: 'BROWSER_REQUEST_RUNTIME_PASS',
      checks: [
        'actual app startup',
        'MV3 request observer',
        'native net.fetch',
        'real tab navigation',
        'repeated fetch'
      ]
    })
  )
}

run()
  .catch(() => console.error(JSON.stringify({ result: 'BROWSER_REQUEST_RUNTIME_FAIL', stage })))
  .finally(() => {
    clearTimeout(deadline)
    server?.closeAllConnections()
    server?.close()
    // Let the app's before-quit cleanup release its profile lock, then preserve the test status.
    app.once('will-quit', () => app.exit(completed ? 0 : 1))
    app.quit()
  })
