// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://app.ja-ja.org/samba/extension-link"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installJajaConnection } from '../src/preload/page-jaja'

const KEY = 'a'.repeat(64)
const HOST = 'jaja-browser-synthetic-host'
const pending = { ok: true, data: { pending: true, hostId: HOST } }

function keyMessage(patch: Partial<MessageEventInit> = {}): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      source: window,
      origin: location.origin,
      data: { source: 'samba-page', type: 'SAMBA_SET_API_KEY', apiKey: KEY },
      ...patch
    })
  )
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
  // Deterministic delivery on the same document; preserves real DOM listener timing.
  vi.spyOn(window, 'postMessage').mockImplementation((data, targetOrigin) => {
    if (targetOrigin === location.origin) {
      window.dispatchEvent(
        new MessageEvent('message', { source: window, origin: location.origin, data })
      )
    }
  })
})
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('JAJA connection page preload handshake', () => {
  it('announces again before the three-second timeout for a listener attached after preload', async () => {
    const ipc = { invoke: vi.fn(async (_channel: string, _value?: unknown) => pending) }
    installJajaConnection(ipc)
    await vi.advanceTimersByTimeAsync(100)
    const received: Array<{ type: string; deviceId?: string }> = []
    const listener = (event: MessageEvent): void => {
      received.push(event.data)
    }
    window.addEventListener('message', listener)
    try {
      await vi.advanceTimersByTimeAsync(450)
      expect(received).toContainEqual({
        source: 'samba-extension',
        type: 'DEVICE_ID',
        deviceId: HOST
      })
      expect(ipc.invoke).toHaveBeenCalledTimes(2)
    } finally {
      window.removeEventListener('message', listener)
    }
  })

  it('stops announcing and forwards the key only once after a valid same-window message', async () => {
    const ipc = { invoke: vi.fn(async (_channel: string, _value?: unknown) => pending) }
    installJajaConnection(ipc)
    await vi.advanceTimersByTimeAsync(0)
    keyMessage()
    keyMessage()
    const announcements = vi.mocked(window.postMessage).mock.calls.length
    await vi.advanceTimersByTimeAsync(3500)
    expect(ipc.invoke.mock.calls.filter(([channel]) => channel === 'jaja:pairKey')).toEqual([
      ['jaja:pairKey', KEY]
    ])
    expect(vi.mocked(window.postMessage).mock.calls).toHaveLength(announcements)
  })

  it('does not restart announcements when a pending status request finishes after key submission', async () => {
    const status = deferred<typeof pending>()
    const ipc = {
      invoke: vi.fn(async (channel: string, _value?: unknown) =>
        channel === 'jaja:pairStatus' ? pending : { ok: true }
      )
    }
    installJajaConnection(ipc)
    await vi.advanceTimersByTimeAsync(0)
    ipc.invoke.mockImplementationOnce(() => status.promise)
    await vi.advanceTimersByTimeAsync(500)
    keyMessage()
    const announcements = vi.mocked(window.postMessage).mock.calls.length
    status.resolve(pending)
    await vi.advanceTimersByTimeAsync(3500)
    expect(vi.mocked(window.postMessage).mock.calls).toHaveLength(announcements)
    expect(ipc.invoke.mock.calls.filter(([channel]) => channel === 'jaja:pairKey')).toHaveLength(1)
  })

  it('does not expose raw status failure details to the page', async () => {
    const ipc = {
      invoke: vi.fn(async (_channel: string, _value?: unknown) => ({
        ok: false,
        error: 'private status failure synthetic-secret'
      }))
    }
    installJajaConnection(ipc)
    await vi.advanceTimersByTimeAsync(3500)
    expect(window.postMessage).not.toHaveBeenCalled()
    keyMessage()
    expect(ipc.invoke).toHaveBeenCalledOnce()
  })

  it('does not expose a rejected key failure or resume key announcements', async () => {
    const ipc = {
      invoke: vi.fn(async (channel: string, _value?: unknown) => {
        if (channel === 'jaja:pairKey') throw new Error('private key failure synthetic-secret')
        return pending
      })
    }
    installJajaConnection(ipc)
    await vi.advanceTimersByTimeAsync(0)
    keyMessage()
    await vi.advanceTimersByTimeAsync(3500)
    expect(JSON.stringify(vi.mocked(window.postMessage).mock.calls)).not.toContain(
      'synthetic-secret'
    )
    expect(ipc.invoke.mock.calls.filter(([channel]) => channel === 'jaja:pairStatus')).toHaveLength(
      1
    )
  })

  it('ignores other origins, other windows and malformed keys', async () => {
    const ipc = { invoke: vi.fn(async (_channel: string, _value?: unknown) => pending) }
    installJajaConnection(ipc)
    await vi.advanceTimersByTimeAsync(0)
    keyMessage({ origin: 'https://outside.example' })
    keyMessage({ source: null })
    keyMessage({ data: { source: 'samba-page', type: 'SAMBA_SET_API_KEY', apiKey: 'invalid' } })
    expect(ipc.invoke).toHaveBeenCalledOnce()
    keyMessage()
    expect(ipc.invoke).toHaveBeenLastCalledWith('jaja:pairKey', KEY)
  })
})
