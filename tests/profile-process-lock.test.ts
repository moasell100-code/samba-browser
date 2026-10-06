import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({ spawn: vi.fn(), mkdirSync: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }))
vi.mock('node:fs', () => ({ mkdirSync: mocked.mkdirSync }))
import { acquireProfileProcessLock } from '../src/main/finance/profile-process-lock'

function processStub(): EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
} {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn()
  })
}

describe('profile ownership across Windows sessions', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.useFakeTimers()
    mocked.spawn.mockReset()
    mocked.mkdirSync.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps the OS lock until the owner finishes and excludes unrelated environment secrets', async () => {
    const child = processStub()
    mocked.spawn.mockReturnValue(child)
    const lost = vi.fn()
    const promise = acquireProfileProcessLock({ profileDir: 'C:\\test-profile', onLost: lost })
    child.stdout.write('LOCKED\r\n')
    const lock = await promise
    expect(lock).not.toBeNull()
    expect(child.stdin.writableEnded).toBe(false)
    const args = mocked.spawn.mock.calls[0]
    expect(args[2]).toMatchObject({ shell: false, windowsHide: true })
    expect(Object.keys(args[2].env).sort()).toEqual([
      'JAJA_PROFILE_LOCK_FILE',
      'SystemRoot',
      'TEMP',
      'TMP'
    ])
    lock!.release()
    lock!.release()
    expect(child.stdin.writableEnded).toBe(true)
    child.emit('exit', 0)
    expect(lost).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('does not start a second profile writer while another session holds the lock', async () => {
    const child = processStub()
    mocked.spawn.mockReturnValue(child)
    const lost = vi.fn()
    const promise = acquireProfileProcessLock({ profileDir: 'C:\\test-profile', onLost: lost })
    child.stdout.write('BUSY\r\n')
    expect(await promise).toBeNull()
    child.emit('exit', 2)
    expect(lost).not.toHaveBeenCalled()
  })

  it('fails closed when the holder dies unexpectedly', async () => {
    const child = processStub()
    mocked.spawn.mockReturnValue(child)
    const lost = vi.fn()
    const promise = acquireProfileProcessLock({ profileDir: 'C:\\test-profile', onLost: lost })
    child.stdout.write('LOCKED\n')
    await promise
    child.emit('exit', 3)
    child.emit('error', new Error('discard this diagnostic'))
    expect(lost).toHaveBeenCalledTimes(1)
  })

  it('rejects a hung helper without leaking diagnostics or leaving its handle alive', async () => {
    const child = processStub()
    mocked.spawn.mockReturnValue(child)
    const promise = acquireProfileProcessLock({ profileDir: 'C:\\test-profile', onLost: vi.fn() })
    const rejected = expect(promise).rejects.toThrow('Browser profile lock unavailable')
    await vi.advanceTimersByTimeAsync(10_000)
    await rejected
    expect(child.kill).toHaveBeenCalledTimes(1)
  })
})
