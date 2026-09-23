// Built-app integration test. Only temporary profiles, synthetic cookies and loopback APIs.
// Run with node_modules/electron/dist/electron.exe scripts/test-jaja-runtime.cjs
const { app, BrowserWindow, session } = require('electron')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jaja-runtime-test-'))
process.env.SAMBA_USER_DATA = profile
app.disableHardwareAcceleration()
const fakeKey = 'a1'.repeat(32)
const accounts = ['A', 'B'].map((name) => ({
  accountId: `test-${name}`,
  site: 'MUSINSA',
  label: `테스트 계정 ${name}`,
  usernameHint: `***${name}`,
  syncSupported: true
}))
const records = new Map()
const writes = []
let hostId = ''
let win
let frontend
let backend
let completed = false
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const deadline = setTimeout(() => {
  console.error('JAJA_RUNTIME_FAIL timeout')
  app.exit(1)
}, 45000)

function serve(handler, port, host) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler)
    server.once('error', reject)
    server.listen(port, host, () => resolve(server))
  })
}
function json(res, value, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
}
async function api(req, res) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}
  const route = req.url.replace('/api/v1/samba/browser', '')
  if (req.headers['x-api-key'] !== fakeKey) return json(res, {}, 401)
  hostId = req.headers['x-device-id']
  if (route === '/accounts') return json(res, { hostId, accounts })
  if (route === '/signals') return json(res, { signals: [] })
  if (route === '/sessions' && req.method === 'GET')
    return json(res, { sessions: [...records.values()] })
  if (route === '/sessions') {
    const record = {
      sessionId: body.sessionId,
      accountId: body.accountId,
      site: 'MUSINSA',
      hostId,
      state: 'observe',
      revision: 0,
      identityState: 'unchecked',
      providerSessionId: null,
      syncSupported: true
    }
    records.set(record.sessionId, record)
    return json(res, record)
  }
  const [, , id, operation] = route.split('/')
  const record = records.get(id)
  if (!record) return json(res, {}, 404)
  if (!operation) return json(res, record)
  if (body.revision !== record.revision) return json(res, {}, 409)
  record.revision++
  if (operation === 'cookies') {
    record.identityState = 'verified'
    record.observedAt = new Date().toISOString()
    const synced = body.mode === 'sync'
    if (synced) {
      record.lastSyncedAt = record.observedAt
      writes.push(record.accountId)
    }
    return json(res, {
      sessionId: id,
      mode: body.mode,
      revision: record.revision,
      identityState: 'verified',
      accepted: true,
      synced,
      lastSyncedAt: record.lastSyncedAt
    })
  }
  if (operation === 'activate') {
    record.state = 'active'
    record.providerSessionId = id
  }
  if (operation === 'pause') record.state = 'paused'
  if (operation === 'release') {
    record.state = 'released'
    record.providerSessionId = null
  }
  return json(res, record)
}

async function ui(expression) {
  return win.webContents.executeJavaScript(expression)
}
async function call(method, ...args) {
  const result = await ui(`window.samba.jaja.${method}(...${JSON.stringify(args)})`)
  assert.equal(result.ok, true, `IPC ${method} failed`)
  return result.data
}
async function waitFor(fn) {
  for (let i = 0; i < 120; i++) {
    const result = await fn()
    if (result) return result
    await sleep(100)
  }
  throw new Error('Condition timed out')
}

async function run() {
  backend = await serve(
    (req, res) => {
      api(req, res).catch(() => json(res, {}, 500))
    },
    0,
    '127.0.0.1'
  )
  frontend = await serve((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(`<html><body>자자 연결 통합 테스트<script>
      window.addEventListener('message', e => {
        if(e.source === window && e.origin === location.origin && e.data?.source === 'samba-extension' && e.data?.type === 'API_KEY_STATUS') {
          window.postMessage({source:'samba-page',type:'SAMBA_SET_API_KEY',apiKey:'${fakeKey}'},location.origin)
        }
      })
    </script></body></html>`)
  }, 3000)
  require(path.join(root, 'out/main/index.js'))
  await app.whenReady()
  win = await waitFor(() => BrowserWindow.getAllWindows()[0])
  win.hide()
  await waitFor(async () => {
    try {
      return await ui('Boolean(window.samba?.jaja)')
    } catch {
      return false
    }
  })
  await call('connect', `http://127.0.0.1:${backend.address().port}`)
  const connected = await waitFor(async () => {
    const status = await call('status')
    return status.connected && status.accounts.length === 2 ? status : null
  })
  assert.equal(
    connected.accounts.every((a) => a.session.state === 'observe'),
    true
  )
  assert.equal(writes.length, 0)
  const sessions = connected.accounts.map((account) =>
    session.fromPartition(`persist:jaja-${account.session.sessionId}`)
  )
  for (let i = 0; i < sessions.length; i++) {
    // No real sourcing-site traffic. Native cookie storage remains real Chromium storage.
    sessions[i].fetch = async () => new Response('synthetic protected page', { status: 200 })
    sessions[i].protocol.handle(
      'https',
      () =>
        new Response('<html><body>격리된 테스트 계정</body></html>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        })
    )
    await sessions[i].cookies.set({
      url: 'https://www.musinsa.com/',
      name: 'test_account',
      value: i === 0 ? 'synthetic-A' : 'synthetic-B',
      httpOnly: true,
      secure: true
    })
  }
  await sleep(100)
  assert.equal((await sessions[0].cookies.get({ name: 'test_account' }))[0].value, 'synthetic-A')
  assert.equal((await sessions[1].cookies.get({ name: 'test_account' }))[0].value, 'synthetic-B')
  await call('open', 'test-A')
  await call('open', 'test-B')
  await sleep(150)
  await call('check', 'test-A')
  await call('check', 'test-B')
  assert.equal(writes.length, 0, 'observe must not write operational cookies')
  const active = await call('activate', 'test-A')
  assert.deepEqual(writes, ['test-A'])
  assert.equal(active.accounts.find((a) => a.accountId === 'test-B').session.state, 'observe')
  const encoded = JSON.stringify(active)
  assert.equal(
    encoded.includes('synthetic-A') || encoded.includes('synthetic-B') || encoded.includes(fakeKey),
    false
  )
  await ui(`document.querySelector('button[aria-label="소싱 계정"]').click()`)
  await waitFor(async () => (await ui('document.body.innerText')).includes('테스트 계정 A'))
  const screenshot = path.join(profile, 'accounts.png')
  win.showInactive()
  await sleep(300)
  fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG())
  win.hide()
  await call('pause', 'test-A')
  await call('check', 'test-A')
  await call('activate', 'test-A')
  await call('release', 'test-A')
  await call('check', 'test-A')
  await call('activate', 'test-A')
  await call('disconnect')
  assert.equal(
    [...records.values()].every((record) => record.state !== 'active'),
    true
  )
  assert.equal((await sessions[0].cookies.get({ name: 'test_account' }))[0].value, 'synthetic-A')
  const settings = JSON.parse(fs.readFileSync(path.join(profile, 'jaja-connection.json')))
  assert.equal(settings.keyCiphertext, undefined)
  completed = true
  console.log(
    JSON.stringify({
      result: 'JAJA_RUNTIME_PASS',
      checks: [
        'real preload pairing',
        'renderer IPC',
        'account partitions',
        'HttpOnly isolation',
        'observe does not write',
        'selected account activation',
        'no secrets in UI DTO',
        'pause/resume/release/reactivate',
        'release before disconnect',
        'login retained'
      ],
      screenshot
    })
  )
}
run()
  .catch((error) => console.error('JAJA_RUNTIME_FAIL', error.message))
  .finally(() => {
    clearTimeout(deadline)
    frontend?.close()
    backend?.close()
    app.exit(completed ? 0 : 1)
  })
