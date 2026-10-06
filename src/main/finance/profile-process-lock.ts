import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

// Electron's singleton is not a substitute for ownership across Windows sessions.
// A kernel file handle has no stale PID/lease race and is released if the holder dies.
// The helper receives only a path; credentials never cross this process boundary.
const HOLD_LOCK = String.raw`
$ErrorActionPreference = 'Stop'
$handle = $null
try {
  try {
    $handle = [System.IO.File]::Open($env:JAJA_PROFILE_LOCK_FILE, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  } catch [System.IO.IOException] {
    if (($_.Exception.HResult -band 0xffff) -in @(32, 33)) {
      [Console]::Out.WriteLine('BUSY')
      [Console]::Out.Flush()
      exit 2
    }
    throw
  }
  [Console]::Out.WriteLine('LOCKED')
  [Console]::Out.Flush()
  $null = [Console]::In.ReadLine()
} catch {
  exit 3
} finally {
  if ($null -ne $handle) { $handle.Dispose() }
}
`

export interface ProfileProcessLock {
  release(): void
}

/** All profile writers take this before opening SQL.js, settings or the vault. */
export async function acquireProfileProcessLock(options: {
  profileDir: string
  onLost(): void
}): Promise<ProfileProcessLock | null> {
  if (process.platform !== 'win32') return { release: () => {} }
  mkdirSync(options.profileDir, { recursive: true })
  const executable = join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  return await new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    let settled = false
    let held = false
    let released = false
    let received = ''
    const unavailable = (): void => {
      if (settled) {
        if (held && !released) {
          held = false
          options.onLost()
        }
        return
      }
      settled = true
      clearTimeout(timer)
      try {
        child?.kill()
      } catch {
        /* already stopped */
      }
      reject(new Error('Browser profile lock unavailable'))
    }
    const timer = setTimeout(unavailable, 10_000)
    try {
      child = spawn(
        executable,
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(HOLD_LOCK, 'utf16le').toString('base64')
        ],
        {
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            SystemRoot: process.env.SystemRoot || 'C:\\Windows',
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
            JAJA_PROFILE_LOCK_FILE: join(options.profileDir, 'profile-process.lock')
          }
        }
      )
    } catch {
      unavailable()
      return
    }
    child.once('error', unavailable)
    child.once('exit', unavailable)
    child.stdin.on('error', unavailable)
    child.stdout.on('error', unavailable)
    child.stderr.on('error', unavailable)
    child.stderr.resume() // Never expose subprocess diagnostics.
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      received += chunk.toString('utf8')
      if (received.length > 64) return unavailable()
      if (!received.includes('\n')) return
      const answer = received.trim()
      if (answer !== 'LOCKED' && answer !== 'BUSY') return unavailable()
      settled = true
      clearTimeout(timer)
      if (answer === 'BUSY') {
        child.stdin.end()
        resolve(null)
        return
      }
      held = true
      resolve({
        release(): void {
          if (released) return
          released = true
          held = false
          // EOF closes the OS handle. No process termination or lock-file deletion.
          child.stdin.end()
        }
      })
    })
  })
}
