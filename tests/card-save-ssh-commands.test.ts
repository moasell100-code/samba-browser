import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveCardCollectionOverSsh } from '../src/main/finance/card-save-ssh'
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('fixed collector command allowlist', () => {
  it.each(['save', 'schedule-report', 'reconcile-lease', 'reconcile-complete'] as const)(
    'uses the fixed destination and private stdin for %s',
    async (command) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn()
      })
      mocks.spawn.mockReturnValue(child)
      const pending = saveCardCollectionOverSsh('PRIVATE_FINANCIAL_BODY', undefined, command)
      const [program, args, options] = mocks.spawn.mock.calls[0]
      expect(program).toBe('ssh')
      expect(args.slice(-2)).toEqual(['app.browser_collector_cli', command])
      expect(args).toContain('me_ri@100.82.217.10')
      expect(args).toContain('money-finance-api-1')
      expect(args).toContain('StrictHostKeyChecking=yes')
      expect(options).toMatchObject({ shell: false, windowsHide: true })
      expect(JSON.stringify(args)).not.toContain('PRIVATE_FINANCIAL_BODY')
      expect(child.stdin.end).toHaveBeenCalledWith('PRIVATE_FINANCIAL_BODY', 'utf8')
      child.stdout.emit('data', Buffer.from('{"ok":true}'))
      child.emit('close', 0)
      await expect(pending).resolves.toEqual({ ok: true })
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['sh', 'save; echo PRIVATE', '--url', '../save', 'reconcile-complete OTHER_HOST'])(
    'rejects unbound commands %s without spawning',
    async (command) => {
      await expect(saveCardCollectionOverSsh('{}', undefined, command as 'save')).rejects.toThrow(
        'Finance collector command invalid'
      )
      expect(mocks.spawn).not.toHaveBeenCalled()
    }
  )
})
