import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
import {
  saveCardCollectionOverSsh,
  CARD_SSH_SAVE_TIMEOUT_MS
} from '../src/main/finance/card-save-ssh'

function child(): EventEmitter & {
  stdin: EventEmitter & { end: ReturnType<typeof vi.fn> }
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
} {
  return Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn()
  })
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('fixed SSH finance save transport', () => {
  it('keeps all private input out of arguments and uses a fixed noninteractive verified destination', async () => {
    const process = child()
    mocks.spawn.mockReturnValue(process)
    const pending = saveCardCollectionOverSsh('PRIVATE_ROW')
    const [command, args, options] = mocks.spawn.mock.calls[0]
    expect(command).toBe('ssh')
    expect(args).toEqual(
      expect.arrayContaining([
        '-F',
        'none',
        'BatchMode=yes',
        'StrictHostKeyChecking=yes',
        'IdentitiesOnly=yes',
        'me_ri@100.82.217.10'
      ])
    )
    expect(args.slice(-10)).toEqual([
      'docker',
      '--context',
      'desktop-linux',
      'exec',
      '-i',
      'money-finance-api-1',
      '/app/.venv/bin/python',
      '-m',
      'app.browser_collector_cli',
      'save'
    ])
    expect(options).toMatchObject({ shell: false, windowsHide: true })
    expect(JSON.stringify(args)).not.toContain('PRIVATE_ROW')
    expect(process.stdin.end).toHaveBeenCalledWith('PRIVATE_ROW', 'utf8')
    process.stdout.emit('data', Buffer.from('{"safe":true}'))
    process.emit('close', 0)
    await expect(pending).resolves.toEqual({ safe: true })
    expect(process.kill).not.toHaveBeenCalled()
  })
  it('never spawns after cancellation or for an oversized body', async () => {
    await expect(saveCardCollectionOverSsh('{}', AbortSignal.abort())).rejects.toThrow(
      'Finance collector save unavailable'
    )
    await expect(saveCardCollectionOverSsh('x'.repeat(8 * 1024 * 1024 + 1))).rejects.toThrow(
      'Finance collection too large'
    )
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
  it.each(['abort', 'timeout', 'stdout', 'stderr', 'error', 'malformed', 'nonzero'] as const)(
    'bounds and redacts %s failures',
    async (mode) => {
      const process = child()
      mocks.spawn.mockReturnValue(process)
      const abort = new AbortController()
      const pending = saveCardCollectionOverSsh('PRIVATE_ROW', abort.signal).catch(
        (error: unknown) => error
      )
      if (mode === 'abort') abort.abort()
      if (mode === 'timeout') await vi.advanceTimersByTimeAsync(CARD_SSH_SAVE_TIMEOUT_MS)
      if (mode === 'stdout' || mode === 'stderr')
        process[mode].emit('data', Buffer.from('PRIVATE_DATA'.repeat(2000)))
      if (mode === 'error') process.emit('error', new Error('PRIVATE_FAILURE'))
      if (mode === 'malformed') {
        process.stdout.emit('data', Buffer.from('PRIVATE_NOT_JSON'))
        process.emit('close', 0)
      }
      if (mode === 'nonzero') {
        process.stderr.emit('data', Buffer.from('PRIVATE_ERROR'))
        process.emit('close', 1)
      }
      const error = await pending
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).not.toContain('PRIVATE')
      expect(process.kill).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})
