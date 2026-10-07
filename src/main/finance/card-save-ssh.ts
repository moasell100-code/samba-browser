import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAX_BODY = 8 * 1024 * 1024
const MAX_REPLY = 16000
export const CARD_SSH_SAVE_TIMEOUT_MS = 45000

/** One fixed deployment destination and command; private JSON travels only over stdin. */
export async function saveCardCollectionOverSsh(
  body: string,
  signal?: AbortSignal,
  command: 'save' | 'schedule-report' | 'reconcile-lease' | 'reconcile-complete' | 'window' = 'save'
): Promise<unknown> {
  if (
    !['save', 'schedule-report', 'reconcile-lease', 'reconcile-complete', 'window'].includes(
      command
    )
  )
    throw new Error('Finance collector command invalid')
  if (Buffer.byteLength(body) > MAX_BODY) throw new Error('Finance collection too large')
  if (signal?.aborted) throw new Error('Finance collector save unavailable')
  return await new Promise((resolve, reject) => {
    const child = spawn(
      'ssh',
      [
        '-T',
        '-F',
        'none',
        '-i',
        join(homedir(), '.ssh', 'id_ed25519_jaja'),
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'ConnectionAttempts=1',
        '-o',
        'ForwardAgent=no',
        '-o',
        'ClearAllForwardings=yes',
        '-o',
        'PermitLocalCommand=no',
        'me_ri@100.82.217.10',
        'docker',
        '--context',
        'desktop-linux',
        'exec',
        '-i',
        'money-finance-api-1',
        '/app/.venv/bin/python',
        '-m',
        'app.browser_collector_cli',
        command
      ],
      { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    let settled = false
    let stdoutBytes = 0
    let stderrBytes = 0
    const chunks: Buffer[] = []
    const finish = (error?: string, value?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      chunks.length = 0
      if (error) {
        try {
          child.kill()
        } catch {
          /* already exited */
        }
        reject(new Error(error))
      } else resolve(value)
    }
    const abort = (): void => finish('Finance collector save unavailable')
    const timer = setTimeout(abort, CARD_SSH_SAVE_TIMEOUT_MS)
    child.on('error', abort)
    child.stdin.on('error', abort)
    child.stdout.on('error', abort)
    child.stderr.on('error', abort)
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_REPLY) return finish('Finance collector receipt invalid')
      chunks.push(Buffer.from(chunk))
    })
    child.stderr.on('data', (chunk: Buffer) => {
      // Discard all diagnostics; an SSH or remote exception may contain sensitive details.
      stderrBytes += chunk.length
      if (stderrBytes > MAX_REPLY) finish('Finance collector save unavailable')
    })
    child.on('close', (code: number | null) => {
      if (settled) return
      if (code !== 0) return finish('Finance collector save rejected')
      try {
        finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        finish('Finance collector receipt invalid')
      }
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) return abort()
    try {
      child.stdin.end(body, 'utf8')
    } catch {
      abort()
    }
  })
}
