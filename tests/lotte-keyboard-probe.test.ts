import { describe, expect, it, vi } from 'vitest'
import type { LotteAuthSnapshot } from '../src/shared/lotte-auth'
import { probeLotteKeyboard } from '../src/main/finance/lotte-keyboard-probe'

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture() {
  let filled = 0
  let focused = false
  let url = 'https://www.lottecard.co.kr/app/LPMANAA_V200.lc'
  let state: LotteAuthSnapshot['state'] = 'keyboard_ready'
  const read = vi.fn(async (): Promise<LotteAuthSnapshot> =>
    state === 'keyboard_ready' ? { state, focused, filled } : { state }
  )
  const bridge = {
    url: () => url,
    read,
    focusPassword: vi.fn(async () => {
      focused = true
      return read()
    }),
    pressCharacter: vi.fn(async () => {
      filled = 1
      return true
    }),
    eraseCharacter: vi.fn(async () => {
      filled = 0
      return true
    })
  }
  const deps = {
    bridge,
    tick: vi.fn((): string | null => null),
    sleep: vi.fn(async () => undefined)
  }
  return {
    deps,
    bridge,
    setFilled: (next: number) => {
      filled = next
    },
    setState: (next: LotteAuthSnapshot['state']) => {
      state = next
    },
    setFocused: (next: boolean) => {
      focused = next
    },
    setUrl: (next: string) => {
      url = next
    }
  }
}

describe('noncredential Lotte keyboard probe', () => {
  it('sends exactly the fixed harmless character once and clears it by native Backspace', async () => {
    const f = fixture()
    expect(await probeLotteKeyboard(f.deps)).toBe('accepted_and_cleared')
    expect(f.bridge.pressCharacter).toHaveBeenCalledExactlyOnceWith('a', 0)
    expect(f.bridge.eraseCharacter).toHaveBeenCalledOnce()
  })
  it('waits for asynchronous acceptance without resending the probe character', async () => {
    const f = fixture()
    let waits = 0
    f.bridge.pressCharacter.mockResolvedValue(true)
    f.deps.sleep.mockImplementation(async () => {
      if (++waits === 3) f.setFilled(1)
    })
    expect(await probeLotteKeyboard(f.deps)).toBe('accepted_and_cleared')
    expect(f.bridge.pressCharacter).toHaveBeenCalledOnce()
  })
  it.each(['keypad_required', 'initializing', 'signed_in'] as const)(
    'does not touch inputs in %s state',
    async (state) => {
      const f = fixture()
      f.setState(state)
      expect(await probeLotteKeyboard(f.deps)).toBe(state === 'initializing' ? 'not_ready' : state)
      expect(f.bridge.pressCharacter).not.toHaveBeenCalled()
      expect(f.bridge.eraseCharacter).not.toHaveBeenCalled()
    }
  )
  it('never replaces or deletes a nonempty existing password field', async () => {
    const f = fixture()
    f.setFilled(2)
    expect(await probeLotteKeyboard(f.deps)).toBe('field_not_empty')
    expect(f.bridge.pressCharacter).not.toHaveBeenCalled()
    expect(f.bridge.eraseCharacter).not.toHaveBeenCalled()
  })
  it('reports unaccepted input and focus loss separately without retries', async () => {
    const f = fixture()
    f.bridge.pressCharacter.mockResolvedValue(true)
    expect(await probeLotteKeyboard(f.deps)).toBe('input_not_accepted')
    expect(f.bridge.pressCharacter).toHaveBeenCalledOnce()
    expect(f.bridge.eraseCharacter).not.toHaveBeenCalled()
    const blurred = fixture()
    blurred.bridge.pressCharacter.mockImplementation(async () => {
      blurred.setFocused(false)
      return true
    })
    expect(await probeLotteKeyboard(blurred.deps)).toBe('input_focus_lost')
    expect(blurred.bridge.eraseCharacter).not.toHaveBeenCalled()
  })
  it('does not erase unexpected input, navigate, or continue after focus/origin changes', async () => {
    const changed = fixture()
    changed.bridge.pressCharacter.mockImplementation(async () => {
      changed.setFilled(2)
      return true
    })
    expect(await probeLotteKeyboard(changed.deps)).toBe('input_count_changed')
    expect(changed.bridge.eraseCharacter).not.toHaveBeenCalled()
    const moved = fixture()
    moved.bridge.focusPassword.mockImplementation(async () => {
      moved.setUrl('https://evil.test')
      return { state: 'keyboard_ready', focused: true, filled: 0 }
    })
    expect(await probeLotteKeyboard(moved.deps)).toBe('navigation_changed')
    expect(moved.bridge.pressCharacter).not.toHaveBeenCalled()
  })
  it('reports cleanup failure instead of claiming the field was cleared', async () => {
    const f = fixture()
    f.bridge.eraseCharacter.mockResolvedValue(false)
    expect(await probeLotteKeyboard(f.deps)).toBe('cleanup_needed')
  })
})
