import { describe, expect, it, vi } from 'vitest'
import type { LotteKeypadMode, LotteKeypadSnapshot } from '../src/shared/lotte-keypad'
import { loginLotteKeypad } from '../src/main/finance/lotte-keypad-login'
import { probeLotteKeypad } from '../src/main/finance/lotte-keypad-probe'
import { probeLotteKeypadLayouts } from '../src/main/finance/lotte-keypad-layout-probe'
import { LOTTE_LOGIN_URL } from '../src/main/finance/lotte-login'

// Entirely synthetic public layouts and test password. No profile or credentials are loaded.
const dummy = 'aA!0a'
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture() {
  let url = LOTTE_LOGIN_URL
  let mode: LotteKeypadMode = 'lower'
  let filled = 0
  let open = false
  let submitted = false
  let revision = 1
  const events: string[] = []
  const maps = {
    lower: [
      { character: 'a', id: 10 },
      { character: '0', id: 11 }
    ],
    upper: [{ character: 'A', id: 12 }],
    special: [{ character: '!', id: 13 }]
  }
  const read = vi.fn(async (): Promise<LotteKeypadSnapshot> =>
    submitted
      ? { state: 'signed_in' }
      : open
        ? {
            state: 'open',
            mode,
            filled,
            layout: revision,
            removeId: 99,
            keys: maps[mode],
            controls:
              mode === 'lower'
                ? [
                    { mode: 'upper', id: 20 },
                    { mode: 'special', id: 21 }
                  ]
                : [
                    { mode: 'lower', id: 22 },
                    ...(mode === 'upper' ? [{ mode: 'special' as const, id: 21 }] : [])
                  ]
          }
        : { state: 'closed', filled, openId: 1, layout: revision }
  )
  const bridge = {
    url: () => url,
    read,
    fillUsername: vi.fn(async () => 'ok'),
    press: vi.fn(async (id: number, count: number, layout: number) => {
      if (count !== filled || layout !== revision) return false
      if (id === 1) open = true
      else if (id >= 20 && id <= 22) {
        mode = id === 20 ? 'upper' : id === 21 ? 'special' : 'lower'
        events.push(mode)
      } else if (maps[mode].some((key) => key.id === id)) {
        filled++
        events.push('key')
        if (mode === 'upper') mode = 'lower'
      } else return false
      revision++
      return true
    }),
    erase: vi.fn(async (layout: number) => {
      if (layout !== revision || filled !== 1) return false
      filled = 0
      revision++
      return true
    }),
    submit: vi.fn(async (count: number) => {
      if (count !== filled) return false
      submitted = true
      return true
    }),
    navigate: vi.fn(async (value: string) => {
      url = value
    }),
    waitForLoad: vi.fn(async () => undefined)
  }
  const deps = {
    bridge,
    attempts: {
      begin: vi.fn(() => true),
      failed: vi.fn(),
      succeeded: vi.fn(),
      clearSignedInProfile: vi.fn()
    },
    attempt: { accountId: 1, itemId: 2, revision: 'opaque-revision', profile: 'unit-profile' },
    readSavedPassword: vi.fn((): string | null => {
      events.push('secret')
      return dummy
    }),
    autoSubmit: true,
    tick: vi.fn((): string | null => null),
    verifyTarget: vi.fn((): string | null => null),
    sleep: vi.fn(async () => undefined)
  }
  return {
    deps,
    bridge,
    events,
    setFilled: (count: number) => {
      filled = count
    },
    setUrl: (value: string) => {
      url = value
    }
  }
}
describe('Lotte dedicated official keypad login', () => {
  it('selects only the first currently verified identical official duplicate symbol key', async () => {
    const f = fixture()
    const original = f.bridge.read.getMockImplementation()!
    f.bridge.read.mockImplementation(async () => {
      const state = await original()
      return state.mode === 'special'
        ? {
            ...state,
            keys: [
              { character: '!', id: 13, label: '느낌표' },
              { character: '!', id: 14, label: '느낌표' }
            ]
          }
        : state
    })
    expect(await loginLotteKeypad(f.deps)).toContain('session verified')
    expect(f.bridge.press.mock.calls.filter(([id]) => id === 13)).toHaveLength(1)
    expect(f.bridge.press.mock.calls.filter(([id]) => id === 14)).toHaveLength(0)
    expect(f.bridge.submit).toHaveBeenCalledOnce()
  })
  it('refuses duplicate candidates with differing public labels before typing that symbol', async () => {
    const f = fixture()
    const original = f.bridge.read.getMockImplementation()!
    f.bridge.read.mockImplementation(async () => {
      const state = await original()
      return state.mode === 'special'
        ? {
            ...state,
            keys: [
              { character: '!', id: 13, label: '느낌표' },
              { character: '!', id: 14, label: 'different' }
            ]
          }
        : state
    })
    expect(await loginLotteKeypad(f.deps)).toContain('stage=preflight_special')
    expect(f.bridge.press.mock.calls.filter(([id]) => id === 13 || id === 14)).toHaveLength(0)
    expect(f.bridge.submit).not.toHaveBeenCalled()
    expect(f.deps.readSavedPassword).not.toHaveBeenCalled()
    expect(f.deps.attempts.begin).not.toHaveBeenCalled()
  })
  it('reports a fixed failure stage for username fill without exposing its value', async () => {
    const f = fixture()
    f.bridge.fillUsername.mockResolvedValue('arbitrary sensitive message')
    const result = await loginLotteKeypad(f.deps)
    expect(result).toContain('stage=fill_username; reason=username_fill_rejected')
    expect(result).not.toContain('arbitrary sensitive message')
    expect(f.deps.readSavedPassword).not.toHaveBeenCalled()
  })
  it('reports public preflight failure reason without reading a secret or consuming a latch', async () => {
    const f = fixture()
    const original = f.bridge.read.getMockImplementation()!
    f.bridge.read.mockImplementation(async () => {
      const state = await original()
      return state.mode === 'upper' ? { state: 'unknown', reason: 'duplicate_mode_control' } : state
    })
    expect(await loginLotteKeypad(f.deps)).toContain(
      'stage=preflight_upper; reason=duplicate_mode_control'
    )
    expect(f.deps.readSavedPassword).not.toHaveBeenCalled()
    expect(f.deps.attempts.begin).not.toHaveBeenCalled()
  })
  it('preflights every mode before reading the secret and submits only after all accepted keys', async () => {
    const f = fixture()
    expect(await loginLotteKeypad(f.deps)).toContain('session verified')
    expect(f.events.slice(0, 4)).toEqual(['upper', 'special', 'lower', 'secret'])
    expect(f.events.filter((event) => event === 'key')).toHaveLength(dummy.length)
    expect(f.bridge.press.mock.calls.every((args) => args.every(Number.isInteger))).toBe(true)
    expect(f.bridge.submit).toHaveBeenCalledOnce()
    expect(f.deps.attempts.begin).toHaveBeenCalledOnce()
    expect(f.deps.attempts.failed).not.toHaveBeenCalled()
    expect(f.deps.attempts.succeeded).toHaveBeenCalledOnce()
  })
  it('rejects unsupported characters before typing any password part or consuming an attempt', async () => {
    const f = fixture()
    f.deps.readSavedPassword.mockReturnValue('a<')
    expect(await loginLotteKeypad(f.deps)).toContain('not supported')
    expect(f.events).not.toContain('key')
    expect(f.deps.attempts.begin).not.toHaveBeenCalled()
    expect(f.bridge.submit).not.toHaveBeenCalled()
  })
  it('keeps the failed latch when one key is not accepted and never resends it', async () => {
    const f = fixture()
    const original = f.bridge.press.getMockImplementation()!
    f.bridge.press.mockImplementation(async (id, count, layout) =>
      id >= 10 && id < 20 ? true : original(id, count, layout)
    )
    expect(await loginLotteKeypad(f.deps)).toContain('input was not accepted')
    expect(f.bridge.press.mock.calls.filter(([id]) => id >= 10 && id < 20)).toHaveLength(1)
    expect(f.deps.attempts.failed).toHaveBeenCalledOnce()
    expect(f.bridge.submit).not.toHaveBeenCalled()
  })
  it('does not type when a persisted attempt exists', async () => {
    const f = fixture()
    f.deps.attempts.begin.mockReturnValue(false)
    expect(await loginLotteKeypad(f.deps)).toContain('already attempted')
    expect(f.events).not.toContain('key')
    expect(f.bridge.submit).not.toHaveBeenCalled()
  })
  it('stops before secret access on nonempty input, disabled submission, or failed preflight', async () => {
    const nonempty = fixture()
    nonempty.setFilled(1)
    expect(await loginLotteKeypad(nonempty.deps)).toContain('not empty')
    expect(nonempty.deps.readSavedPassword).not.toHaveBeenCalled()
    const disabled = fixture()
    disabled.deps.autoSubmit = false
    expect(await loginLotteKeypad(disabled.deps)).toContain('disabled')
    expect(disabled.deps.readSavedPassword).not.toHaveBeenCalled()
    const failed = fixture()
    failed.bridge.press.mockResolvedValue(false)
    expect(await loginLotteKeypad(failed.deps)).toContain('could not be verified')
    expect(failed.deps.readSavedPassword).not.toHaveBeenCalled()
  })
  it('stops on cross-origin navigation and masks thrown secret messages', async () => {
    const f = fixture()
    f.bridge.read.mockImplementation(async () => {
      f.setUrl('https://evil.test')
      return { state: 'closed', filled: 0, openId: 1, layout: 1 }
    })
    expect(await loginLotteKeypad(f.deps)).toContain('could not be verified')
    expect(f.deps.readSavedPassword).not.toHaveBeenCalled()
    const error = fixture()
    error.deps.readSavedPassword.mockImplementation(() => {
      throw new Error(dummy)
    })
    expect(await loginLotteKeypad(error.deps)).not.toContain(dummy)
    expect(error.bridge.submit).not.toHaveBeenCalled()
  })
})
describe('Lotte official keypad harmless diagnostic', () => {
  it('inspects every public layout with no password keys, Vault access or latch mutations', async () => {
    const f = fixture()
    expect(await probeLotteKeypadLayouts(f.deps)).toEqual({ stage: 'complete', reason: 'verified' })
    expect(f.bridge.press.mock.calls.map(([id]) => id)).toEqual([1, 20, 21, 22])
    expect(f.deps.readSavedPassword).not.toHaveBeenCalled()
    expect(f.bridge.submit).not.toHaveBeenCalled()
    expect(f.bridge.erase).not.toHaveBeenCalled()
    expect(f.deps.attempts.begin).not.toHaveBeenCalled()
  })
  it('reports only fixed public stage/reason and leaves existing input untouched', async () => {
    const f = fixture()
    const original = f.bridge.read.getMockImplementation()!
    f.bridge.read.mockImplementation(async () => {
      const state = await original()
      return state.mode === 'special' ? { state: 'unknown', reason: 'unknown_label' } : state
    })
    expect(await probeLotteKeypadLayouts(f.deps)).toEqual({
      stage: 'preflight_special',
      reason: 'unknown_label'
    })
    expect(f.deps.readSavedPassword).not.toHaveBeenCalled()
    expect(f.events).not.toContain('key')
    const existing = fixture()
    existing.setFilled(1)
    expect(await probeLotteKeypadLayouts(existing.deps)).toEqual({
      stage: 'initial_state',
      reason: 'nonempty'
    })
    expect(existing.bridge.press).not.toHaveBeenCalled()
    expect(existing.bridge.erase).not.toHaveBeenCalled()
  })
  it('presses only fixed public a then official delete-one, never submits or reads a secret', async () => {
    const f = fixture()
    expect(await probeLotteKeypad(f.deps)).toBe('accepted_and_cleared')
    expect(f.bridge.press.mock.calls.map(([id]) => id)).toEqual([1, 10])
    expect(f.bridge.erase).toHaveBeenCalledOnce()
    expect(f.deps.readSavedPassword).not.toHaveBeenCalled()
    expect(f.bridge.submit).not.toHaveBeenCalled()
    expect(f.deps.attempts.begin).not.toHaveBeenCalled()
  })
  it('never clears an existing password or claims an unconfirmed cleanup', async () => {
    const nonempty = fixture()
    nonempty.setFilled(1)
    expect(await probeLotteKeypad(nonempty.deps)).toBe('nonempty')
    expect(nonempty.bridge.press).not.toHaveBeenCalled()
    expect(nonempty.bridge.erase).not.toHaveBeenCalled()
    const stuck = fixture()
    stuck.bridge.erase.mockResolvedValue(true)
    expect(await probeLotteKeypad(stuck.deps)).toBe('cleanup_not_confirmed')
    expect(stuck.bridge.erase).toHaveBeenCalledOnce()
  })
})
