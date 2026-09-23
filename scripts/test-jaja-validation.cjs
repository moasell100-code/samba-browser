// End-to-end: actual built Electron app + actual browser API + separate PostgreSQL.
// Sites and accounts are synthetic. Run only after validation-environment start.
const { app, BrowserWindow, session, webContents } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const root = path.resolve(__dirname, '..')
const restart = process.argv.includes('--restart')
const keepOpen = process.argv.includes('--keep-open')
const profileArg = process.argv.find((value) => value.startsWith('--profile='))?.slice(10)
const profile =
  profileArg ||
  path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'jaja-validation-e2e-')),
    'JAJA-Browser-Validation'
  )
process.env.JAJA_VALIDATION = '1'
process.env.SAMBA_USER_DATA = profile
fs.mkdirSync(profile, { recursive: true })
app.disableHardwareAcceleration()
let win
let passed = false
app.on('will-quit', (event) => {
  if (!passed) {
    event.preventDefault()
    app.exit(1)
  }
})
const checks = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const deadline = setTimeout(() => {
  console.error('JAJA_VALIDATION_FAIL timeout')
  app.exit(1)
}, 150000)
const API = 'http://127.0.0.1:18300'
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex')
async function api(route, body) {
  const response = await fetch(API + '/__validation__/' + route, {
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' }
        }),
    signal: AbortSignal.timeout(12000),
    redirect: 'error'
  })
  assert.equal(response.ok, true, `Fixture API ${route} failed: ${response.status}`)
  return response.json()
}
async function ui(expression) {
  return win.webContents.executeJavaScript(expression)
}
async function call(method, ...args) {
  const result = await ui(`window.samba.jaja.${method}(...${JSON.stringify(args)})`)
  assert.equal(result.ok, true, `IPC ${method}: ${result.error || ''}`)
  return result.data
}
async function waitFor(fn) {
  for (let i = 0; i < 150; i++) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw Error('Condition timed out')
}
const site = (id) =>
  id.includes('_musinsa_')
    ? 'https://www.musinsa.com'
    : id.includes('_cm29_')
      ? 'https://www.29cm.co.kr'
      : id.includes('_lotte_')
        ? 'https://www.lotteon.com'
        : 'https://abcmart.a-rt.com'
const account = (status, id) => status.accounts.find((value) => value.accountId === id)
const snapAccount = (status, id) => status.accounts.find((value) => value.accountId === id)
let connected
function native(id) {
  return session.fromPartition(`persist:jaja-${account(connected, id).session.sessionId}`)
}
async function login(partitionId, ownerId = partitionId) {
  const response = await native(partitionId).fetch(
    `${site(partitionId)}/__validation__/login?accountId=${ownerId}`
  )
  assert.equal(response.status, 200, 'Local synthetic login')
  await sleep(100)
}
async function verify(id, state = 'verified') {
  const result = await call('check', id)
  const value = account(result, id)
  assert.equal(
    value.browserIdentityState,
    state,
    `${id}: ${JSON.stringify({ message: value.message, server: value.session.identityState, browser: value.browserIdentityState })}`
  )
  return result
}
async function run() {
  // Profile/scheme/network configuration must run before Electron becomes ready.
  require(path.join(root, 'out', 'main', 'index.js'))
  const status = await api('status')
  assert.equal(status.syntheticOnly, true)
  assert.equal(status.database, 'jaja_browser_validation')
  if (!restart) {
    const generation = 100 + (Date.now() % 900000)
    for (const item of status.accounts)
      await api(`accounts/${item.accountId}/scenario`, { state: 'valid', generation })
  }
  const before = await api('snapshot')
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
  if (!restart) {
    const rejected = await ui("window.samba.jaja.connect('https://api.ja-ja.org')")
    assert.equal(rejected.ok, false)
    assert.equal((await call('status')).connected, false)
    await call('connect', API)
  }
  connected = await waitFor(async () => {
    const data = await call('status')
    return data.connected && data.accounts.length === 8 ? data : false
  })
  assert.equal(connected.validation, true)
  checks.push('real preload pairing and 8 PostgreSQL account sessions')
  if (restart) {
    const saved = JSON.parse(
      fs.readFileSync(path.join(profile, 'validation-expected.json'), 'utf8')
    )
    for (const record of saved.accounts) {
      assert.equal(account(connected, record.accountId).session.sessionId, record.sessionId)
      const values = await native(record.accountId).cookies.get({ name: 'jaja_validation' })
      assert.equal(hash(values[0].value), record.cookieHash, 'persistent native cookie')
    }
    assert.equal(account(connected, 'sa_val_musinsa_a').session.state, 'active')
    await verify('sa_val_musinsa_a')
    checks.push(
      'browser restart restores same encrypted pairing, session IDs, cookies and provider ownership'
    )
    await call('disconnect')
    const after = await api('snapshot')
    assert.equal(
      after.accounts.some((item) =>
        saved.accounts.some((a) => a.sessionId === item.providerSessionId)
      ),
      false
    )
    for (const record of saved.accounts)
      assert.equal(
        (await native(record.accountId).cookies.get({ name: 'jaja_validation' })).length,
        1
      )
    checks.push('disconnect releases providers while retaining isolated logins')
  } else {
    assert.equal(
      connected.accounts.every((item) => item.session.state === 'observe'),
      true
    )
    await waitFor(async () => (await ui('document.body.innerText')).includes('검증 전용 MUSINSA A'))
    await ui(
      `Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('로그인 공간 열기')).click()`
    )
    const siteTab = await waitFor(() =>
      webContents
        .getAllWebContents()
        .find(
          (wc) =>
            wc.session === native('sa_val_musinsa_a') &&
            wc.getURL().startsWith(site('sa_val_musinsa_a'))
        )
    )
    await waitFor(async () =>
      (await siteTab.executeJavaScript('document.body.innerText')).includes('가상 로그인')
    )
    await siteTab.executeJavaScript(
      `document.querySelector('a[href="/__validation__/login?accountId=sa_val_musinsa_a"]').click()`
    )
    await waitFor(async () =>
      (await siteTab.executeJavaScript('document.body.innerText')).includes('무신사 A (valid)')
    )
    await waitFor(async () => (await ui('document.body.innerText')).includes('무신사 · 검증 전용'))
    checks.push(
      'visible login-space button opens a selectable account tab and synthetic login works'
    )
    for (const item of connected.accounts) {
      await call('open', item.accountId)
      await login(item.accountId)
      await verify(item.accountId)
    }
    const observed = await api('snapshot')
    for (const item of before.accounts)
      assert.equal(
        snapAccount(observed, item.accountId).cookieSha256,
        item.cookieSha256,
        'observe must not change saved cookie'
      )
    checks.push('8 accounts / 4 sites observe successfully without changing saved cookies')
    for (const group of ['musinsa', 'cm29', 'lotte', 'abc']) {
      const a = await native(`sa_val_${group}_a`).cookies.get({ name: 'jaja_validation' })
      const b = await native(`sa_val_${group}_b`).cookies.get({ name: 'jaja_validation' })
      assert.equal(a.length, 1)
      assert.equal(b.length, 1)
      assert.equal(a[0].httpOnly, true)
      assert.notEqual(a[0].value, b[0].value, 'account cookies must not overlap')
    }
    checks.push('native HttpOnly cookie jars are independent across all accounts')
    await call('activate', 'sa_val_musinsa_a')
    const active = await api('snapshot')
    assert.equal(
      snapAccount(active, 'sa_val_musinsa_a').providerSessionId,
      account(connected, 'sa_val_musinsa_a').session.sessionId
    )
    assert.notEqual(
      snapAccount(active, 'sa_val_musinsa_a').cookieSha256,
      snapAccount(before, 'sa_val_musinsa_a').cookieSha256
    )
    for (const other of before.accounts.filter((a) => a.accountId !== 'sa_val_musinsa_a'))
      assert.equal(snapAccount(active, other.accountId).cookieSha256, other.cookieSha256)
    for (const item of before.accounts)
      assert.equal(
        snapAccount(active, item.accountId).pinnedDeviceId,
        item.pinnedDeviceId,
        'ordering device pin must remain'
      )
    checks.push('activation updates only the selected account and preserves ordering device pins')
    await login('sa_val_musinsa_a', 'sa_val_musinsa_b')
    await verify('sa_val_musinsa_a', 'mismatch')
    assert.equal(
      snapAccount(await api('snapshot'), 'sa_val_musinsa_a').cookieSha256,
      snapAccount(active, 'sa_val_musinsa_a').cookieSha256
    )
    checks.push('wrong-account cookies are rejected without overwriting saved session')
    await api('accounts/sa_val_musinsa_a/scenario', { state: 'expired', generation: 2 })
    await login('sa_val_musinsa_a')
    await verify('sa_val_musinsa_a', 'expired')
    assert.equal(
      snapAccount(await api('snapshot'), 'sa_val_musinsa_a').cookieSha256,
      snapAccount(active, 'sa_val_musinsa_a').cookieSha256
    )
    await api('accounts/sa_val_musinsa_a/scenario', { state: 'unavailable', generation: 3 })
    await login('sa_val_musinsa_a')
    await verify('sa_val_musinsa_a', 'unknown')
    assert.equal(
      snapAccount(await api('snapshot'), 'sa_val_musinsa_a').cookieSha256,
      snapAccount(active, 'sa_val_musinsa_a').cookieSha256
    )
    checks.push('expired and unavailable logins cannot replace the working cookie')
    await api('accounts/sa_val_musinsa_a/scenario', { state: 'valid', generation: 4 })
    await login('sa_val_musinsa_a')
    await verify('sa_val_musinsa_a')
    await call('pause', 'sa_val_musinsa_a')
    const paused = await api('snapshot')
    const legacyFixture = await api('fixture/sa_val_musinsa_a')
    await api('accounts/sa_val_musinsa_a/legacy-cookie', {
      cookie: legacyFixture.cookie.replace(':4', ':40')
    })
    assert.equal(
      snapAccount(await api('snapshot'), 'sa_val_musinsa_a').cookieSha256,
      snapAccount(paused, 'sa_val_musinsa_a').cookieSha256
    )
    await call('release', 'sa_val_musinsa_a')
    await api('accounts/sa_val_musinsa_a/legacy-cookie', {
      cookie: legacyFixture.cookie.replace(':4', ':41')
    })
    assert.notEqual(
      snapAccount(await api('snapshot'), 'sa_val_musinsa_a').cookieSha256,
      snapAccount(paused, 'sa_val_musinsa_a').cookieSha256
    )
    checks.push('pause keeps legacy writer blocked; release restores legacy cookie updates')
    await verify('sa_val_musinsa_a')
    await call('activate', 'sa_val_musinsa_a')
    for (const browser of [session.defaultSession, native('sa_val_musinsa_a')]) {
      for (const url of ['https://api.ja-ja.org/', 'https://example.com/']) {
        // Custom HTTPS handlers may run before webRequest. Both paths are local
        // denials; a protocol-generated 403 is not a failed external request.
        const response = await browser.fetch(url)
        assert.equal(response.status, 403)
        assert.equal(await response.text(), 'Validation network blocked')
      }
    }
    checks.push('production connection and external browser requests are blocked')
    await ui(`document.querySelector('button[aria-label="소싱 계정"]').click()`)
    await waitFor(async () => (await ui('document.body.innerText')).includes('검증 전용'))
    win.showInactive()
    await sleep(300)
    fs.writeFileSync(
      path.join(profile, 'validation-accounts.png'),
      (await win.webContents.capturePage()).toPNG()
    )
    win.hide()
    const saved = []
    for (const item of connected.accounts) {
      const cookies = await native(item.accountId).cookies.get({ name: 'jaja_validation' })
      await native(item.accountId).cookies.flushStore()
      saved.push({
        accountId: item.accountId,
        sessionId: item.session.sessionId,
        cookieHash: hash(cookies[0].value)
      })
    }
    fs.writeFileSync(
      path.join(profile, 'validation-expected.json'),
      JSON.stringify({ accounts: saved })
    )
  }
  console.log(
    JSON.stringify({
      result: 'JAJA_VALIDATION_PASS',
      restart,
      checks,
      profile,
      screenshot: path.join(profile, 'validation-accounts.png')
    })
  )
  passed = true
}
run()
  .catch(async (error) => {
    console.error('JAJA_VALIDATION_FAIL', error.stack)
    if (win && !win.isDestroyed()) {
      console.error(
        'VALIDATION_UI_DEBUG',
        JSON.stringify({
          text: await ui('document.body.innerText'),
          tabs: await ui('window.samba.tabs.list()')
        })
      )
      fs.writeFileSync(
        path.join(profile, 'failure.png'),
        (await win.webContents.capturePage()).toPNG()
      )
    }
  })
  .finally(() => {
    clearTimeout(deadline)
    if (passed && keepOpen) {
      win.show()
      win.focus()
      return
    }
    app.quit()
    setTimeout(() => app.exit(passed ? 0 : 1), 1000)
  })
