import { describe, expect, it, vi } from 'vitest'
import type { Tab } from '../src/main/browser/tab-manager'
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => ({ isFocused: () => true }) },
  app: { getPath: () => '' }
}))
vi.mock('../src/main/browser/frame-channel', () => ({ callFrameOp: vi.fn() }))
const { pageBridge } = await import('../src/main/browser/page-bridge')
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture(result: unknown = { state: 'keyboard_ready', focused: true, filled: 0 }) {
  let url = 'https://www.lottecard.co.kr/app/LPMANAA_V200.lc'
  const execute = vi.fn(async () => result)
  const send = vi.fn()
  const wc = {
    getURL: () => url,
    isDestroyed: () => false,
    executeJavaScriptInIsolatedWorld: execute,
    isFocused: () => true,
    focus: vi.fn(),
    sendInputEvent: send
  }
  return {
    tab: { view: { webContents: wc } } as unknown as Tab,
    execute,
    send,
    setUrl: (next: string) => {
      url = next
    }
  }
}
describe('Lotte native keyboard bridge', () => {
  it('erases only one focused probe character with a normal Backspace key event', async () => {
    const f = fixture({ state: 'keyboard_ready', focused: true, filled: 1 })
    expect(await pageBridge.eraseLotteProbeCharacter(f.tab)).toBe(true)
    expect(f.send.mock.calls.map(([event]) => event)).toEqual([
      { type: 'keyDown', keyCode: 'Backspace' },
      { type: 'keyUp', keyCode: 'Backspace' }
    ])
    const unrelated = fixture({ state: 'keyboard_ready', focused: true, filled: 2 })
    expect(await pageBridge.eraseLotteProbeCharacter(unrelated.tab)).toBe(false)
    expect(unrelated.send).not.toHaveBeenCalled()
  })
  it('sends one keyboard event triplet without embedding its character in evaluated source', async () => {
    const f = fixture()
    expect(await pageBridge.pressLotteCharacter(f.tab, '!', 0)).toBe(true)
    expect(f.send.mock.calls.map(([event]) => event.type)).toEqual(['keyDown', 'char', 'keyUp'])
    expect(f.execute).toHaveBeenCalledWith(999, [{ code: '__samba.lotteAuth()' }])
    expect(f.send.mock.calls[0][0]).toEqual({ type: 'keyDown', keyCode: '1', modifiers: ['shift'] })
  })
  it.each([
    { state: 'keypad_required' },
    { state: 'initializing' },
    { state: 'keyboard_ready', focused: false, filled: 0 },
    { state: 'keyboard_ready', focused: true, filled: 1 }
  ])('does not emit input unless the official empty field has focus: %j', async (state) => {
    const f = fixture(state)
    expect(await pageBridge.pressLotteCharacter(f.tab, 'a', 0)).toBe(false)
    expect(f.send).not.toHaveBeenCalled()
  })
  it('stops on navigation and strips extra returned data', async () => {
    const f = fixture({ state: 'keypad_required', secret: 'private' })
    expect(await pageBridge.lotteAuth(f.tab)).toEqual({ state: 'keypad_required' })
    f.execute.mockImplementation(async () => {
      f.setUrl('https://evil.test/')
      return { state: 'keyboard_ready', focused: true, filled: 0 }
    })
    expect(await pageBridge.pressLotteCharacter(f.tab, 'a', 0)).toBe(false)
    expect(f.send).not.toHaveBeenCalled()
  })
  it('masks native input exceptions', async () => {
    const f = fixture()
    f.send.mockImplementation(() => {
      throw new Error('private')
    })
    expect(await pageBridge.pressLotteCharacter(f.tab, 'a', 0)).toBe(false)
  })
})
