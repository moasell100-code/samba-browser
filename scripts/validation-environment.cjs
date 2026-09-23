// Local-only launcher. The backend's dedicated module never imports production startup.
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const lab = path.join(process.env.LOCALAPPDATA, 'JAJA-Browser-Validation-Lab')
const profile = path.join(process.env.LOCALAPPDATA, 'JAJA-Browser-Validation')
const manifestFile = path.join(lab, 'services.json')
const args = process.argv.slice(2)
const action = args[0] || 'start'
const value = (key) => (args.includes(key) ? args[args.indexOf(key) + 1] : undefined)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))

function quoteWindowsArgument(argument) {
  if (argument !== '' && !/[\s"]/.test(argument)) return argument
  return (
    '"' +
    argument
      .replace(/(\\*)"/g, (_, slashes) => slashes + slashes + '\\"')
      .replace(/(\\+)$/, (slashes) => slashes + slashes) +
    '"'
  )
}
function expectedCommandLine(entry) {
  return [entry.command, ...entry.arguments].map(quoteWindowsArgument).join(' ')
}
function readProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  // Only the validated integer PID enters this fixed, read-only PowerShell code.
  const script = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p){ @{pid=[int]$p.ProcessId;command=$p.ExecutablePath;commandLine=$p.CommandLine;createdAt=$p.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress }`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10000
  })
  if (result.error || result.status !== 0) throw Error('Cannot verify validation process ownership')
  return result.stdout.trim() ? JSON.parse(result.stdout.replace(/^\uFEFF/, '')) : null
}
function ownsProcess(entry, identity = readProcessIdentity(entry?.pid)) {
  if (
    !entry ||
    !identity ||
    identity.pid !== entry.pid ||
    typeof entry.command !== 'string' ||
    typeof identity.command !== 'string' ||
    entry.command.toLowerCase() !== identity.command.toLowerCase() ||
    !Array.isArray(entry.arguments) ||
    entry.arguments.some((argument) => typeof argument !== 'string') ||
    identity.commandLine !== expectedCommandLine(entry)
  )
    return false
  if (entry.createdAt || entry.commandLine)
    return entry.createdAt === identity.createdAt && entry.commandLine === identity.commandLine
  // Migrate only the processes launched moments before the old manifest timestamp.
  const delta = Math.abs(Date.parse(identity.createdAt) - Date.parse(entry.startedAt))
  if (!Number.isFinite(delta) || delta > 2000) return false
  entry.createdAt = identity.createdAt
  entry.commandLine = identity.commandLine
  return true
}

async function health(port, marker) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/__validation__/status`, {
      signal: AbortSignal.timeout(1000),
      redirect: 'error'
    })
    const data = await response.json()
    if (!response.ok || data.environment !== marker || data.syntheticOnly !== true)
      throw Error('port is occupied by an unrelated service')
    return true
  } catch (error) {
    if (error.message.includes('unrelated')) throw error
    return false
  }
}
function postgres(operation) {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(__dirname, 'validation-postgres.ps1'),
      '-Action',
      operation
    ],
    { windowsHide: true, stdio: 'inherit' }
  )
  if (result.status !== 0) throw Error('Validation PostgreSQL operation failed')
}
function environment() {
  const result = {}
  for (const key of [
    'SystemRoot',
    'WINDIR',
    'PATH',
    'TEMP',
    'TMP',
    'LOCALAPPDATA',
    'APPDATA',
    'COMSPEC'
  ]) {
    const found = Object.keys(process.env).find((name) => name.toLowerCase() === key.toLowerCase())
    if (found) result[key] = process.env[found]
  }
  return result
}
function launch(name, command, commandArgs, cwd, extraEnv = {}, trackProcess = true) {
  const stdout = fs.openSync(path.join(lab, name + '.out.log'), 'a')
  const stderr = fs.openSync(path.join(lab, name + '.err.log'), 'a')
  const executable = path.resolve(command)
  const child = spawn(executable, commandArgs, {
    cwd,
    detached: true,
    windowsHide: true,
    env: { ...environment(), ...extraEnv },
    stdio: ['ignore', stdout, stderr]
  })
  child.on('error', () => {})
  child.unref()
  fs.closeSync(stdout)
  fs.closeSync(stderr)
  const entry = {
    pid: child.pid,
    command: executable,
    arguments: commandArgs,
    startedAt: new Date().toISOString()
  }
  // The extra Electron instance only focuses an already verified owner and may
  // exit before CIM can observe it. It must never replace that owner's metadata.
  if (!trackProcess) return null
  const identity = readProcessIdentity(child.pid)
  if (!ownsProcess(entry, identity)) throw Error('Cannot establish ownership of validation ' + name)
  return entry
}
async function waitHealth(port, marker) {
  for (let i = 0; i < 100; i++) {
    if (await health(port, marker)) return
    await delay(300)
  }
  throw Error('Validation service did not start; inspect logs in ' + lab)
}
async function main() {
  if (!['setup', 'start', 'status'].includes(action)) throw Error('Use setup, start, or status')
  if (action === 'status') {
    console.log(
      JSON.stringify({
        backend: await health(18300, 'jaja-browser-validation'),
        frontend: await health(18301, 'jaja-browser-validation-frontend'),
        profile
      })
    )
    return
  }
  postgres(action === 'setup' ? 'setup' : 'start')
  const connection = readJson(path.join(lab, 'connection.json'))
  const url = new URL(connection.databaseUrl.replace('postgresql+asyncpg:', 'postgresql:'))
  if (
    url.hostname !== '127.0.0.1' ||
    url.port !== '15432' ||
    url.pathname !== '/jaja_browser_validation'
  )
    throw Error('Isolated database configuration required')
  let manifest = fs.existsSync(manifestFile) ? readJson(manifestFile) : {}
  if (manifest.environment && manifest.environment !== 'jaja-browser-validation')
    throw Error('Unrecognized service manifest')
  manifest.environment = 'jaja-browser-validation'
  const backendRoot = path.resolve(value('--backend-root') || manifest.backendRoot || '')
  const python = value('--python') || manifest.python
  if (
    !python ||
    !fs.existsSync(python) ||
    !fs.existsSync(
      path.join(backendRoot, 'backend', 'backend', 'browser_validation', '__main__.py')
    )
  )
    throw Error(
      'Specify --backend-root and --python for the isolated backend source and Python runtime'
    )
  manifest.backendRoot = backendRoot
  manifest.python = python
  const save = () => fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
  for (const name of ['backend', 'frontend', 'browser']) {
    if (manifest[name] && !ownsProcess(manifest[name])) {
      console.warn('Ignoring stale or unowned validation process: ' + name)
      delete manifest[name]
    }
  }
  if (!(await health(18300, 'jaja-browser-validation'))) {
    manifest.backend = launch(
      'backend',
      python,
      ['-m', 'backend.browser_validation'],
      path.join(backendRoot, 'backend'),
      {
        JAJA_VALIDATION_DATABASE_URL: connection.databaseUrl,
        PYTHONUTF8: '1',
        PYTHONDONTWRITEBYTECODE: '1'
      }
    )
    save()
    await waitHealth(18300, 'jaja-browser-validation')
  }
  if (!(await health(18301, 'jaja-browser-validation-frontend'))) {
    manifest.frontend = launch(
      'frontend',
      process.execPath,
      [path.join(__dirname, 'validation-frontend.cjs')],
      root
    )
    save()
    await waitHealth(18301, 'jaja-browser-validation-frontend')
  }
  if (!args.includes('--services-only')) {
    const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
    if (!fs.existsSync(path.join(root, 'out', 'main', 'index.js')))
      throw Error('Build the browser first')
    fs.mkdirSync(profile, { recursive: true })
    const alreadyRunning = Boolean(manifest.browser && ownsProcess(manifest.browser))
    const browserArgs = args.includes('--prepare-demo')
      ? [path.join(__dirname, 'test-jaja-validation.cjs'), `--profile=${profile}`, '--keep-open']
      : [path.join(root, 'out', 'main', 'index.js')]
    if (
      args.includes('--prepare-demo') &&
      (alreadyRunning || fs.existsSync(path.join(profile, 'jaja-connection.json')))
    )
      throw Error('Demo preparation requires a fresh validation profile')
    const launched = launch(
      'browser',
      electron,
      browserArgs,
      root,
      { JAJA_VALIDATION: '1', SAMBA_USER_DATA: profile },
      !alreadyRunning
    )
    // A second instance focuses the existing window and exits. Retain its real
    // owner's PID so the explicit stop script can still target it correctly.
    if (!alreadyRunning) manifest.browser = launched
  }
  save()
  console.log(
    JSON.stringify({
      environment: manifest.environment,
      backend: 'http://127.0.0.1:18300',
      frontend: 'http://localhost:18301',
      profile,
      productionConnected: false
    })
  )
}
module.exports = { quoteWindowsArgument, readProcessIdentity, ownsProcess }
if (require.main === module) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
