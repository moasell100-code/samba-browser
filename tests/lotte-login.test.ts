import { describe, expect, it, vi } from 'vitest'
import type { LotteAuthSnapshot } from '../src/shared/lotte-auth'
import { LOTTE_LOGIN_URL, loginLotteCard } from '../src/main/finance/lotte-login'

// Generated fixture only; these tests never load a credential or a browser profile.
const dummy = Array.from({ length: 8 }, (_, index) => String(index)).join('')
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture() {
  let url = LOTTE_LOGIN_URL
  let filled = 0
  let focused = false
  let submitted = false
  let state: LotteAuthSnapshot['state'] = 'keyboard_ready'
  const read = vi.fn(async (): Promise<LotteAuthSnapshot> =>
    submitted
      ? { state: 'signed_in' }
      : state === 'keyboard_ready'
        ? { state, focused, filled }
        : { state }
  )
  const bridge = {
    url: () => url,
    read,
    focusPassword: vi.fn(async () => {
      focused = true
      return read()
    }),
    fillUsername: vi.fn(async () => 'ok'),
    pressCharacter: vi.fn(async (_character: string, expected: number) => {
      if (expected !== filled) return false
      filled++
      return true
    }),
    submit: vi.fn(async () => {
      submitted = true
      return true
    }),
    navigate: vi.fn(async (next: string) => {
      url = next
      state = 'keyboard_ready'
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
    attempt: { accountId: 7, itemId: 8, revision: 'opaque-revision', profile: 'unit-profile' },
    readSavedPassword: vi.fn((): string | null => dummy),
    autoSubmit: true,
    tick: vi.fn((): string | null => null),
    verifyTarget: vi.fn((): string | null => null),
    sleep: vi.fn(async () => undefined)
  }
  return {
    deps,
    bridge,
    setState: (value: LotteAuthSnapshot['state']) => {
      state = value
    },
    setUrl: (value: string) => {
      url = value
    }
  }
}

describe('Lotte keyboard login', () => {
  it('types through the guarded native path once and verifies signed-in state', async () => {
    const f = fixture()
    expect(await loginLotteCard(f.deps)).toContain('session verified')
    expect(f.bridge.pressCharacter).toHaveBeenCalledTimes(dummy.length)
    expect(f.bridge.submit).toHaveBeenCalledOnce()
    expect(f.deps.attempts.succeeded).toHaveBeenCalledOnce()
  })
  it.each(['keypad_required', 'input_error', 'initializing'] as const)(
    'never reads a password or submits in %s state',
    async (state) => {
      const f = fixture()
      f.setState(state)
      expect(await loginLotteCard(f.deps)).toMatch(/needs_user|refused/)
      expect(f.deps.readSavedPassword).not.toHaveBeenCalled()
      expect(f.bridge.pressCharacter).not.toHaveBeenCalled()
      expect(f.bridge.submit).not.toHaveBeenCalled()
    }
  )
  it('rechecks readonly after focus before fetching the saved credential', async () => {
    const f = fixture()
    f.bridge.focusPassword.mockResolvedValue({ state: 'keypad_required' })
    expect(await loginLotteCard(f.deps)).toContain('keypad_required')
    expect(f.deps.readSavedPassword).not.toHaveBeenCalled()
  })
  it('reuses signed-in sessions without input and enters canonical login once for expired pages', async () => {
    const f = fixture()
    f.setState('signed_in')
    expect(await loginLotteCard(f.deps)).toContain('session verified')
    expect(f.deps.readSavedPassword).not.toHaveBeenCalled()
    const expired = fixture()
    expired.setState('unknown')
    expect(await loginLotteCard(expired.deps)).toContain('session verified')
    expect(expired.bridge.navigate).toHaveBeenCalledExactlyOnceWith(LOTTE_LOGIN_URL)
  })
  it('blocks duplicate attempts and never submits after an input failure', async () => {
    const repeated = fixture()
    repeated.deps.attempts.begin.mockReturnValue(false)
    expect(await loginLotteCard(repeated.deps)).toContain('already attempted')
    expect(repeated.bridge.pressCharacter).not.toHaveBeenCalled()
    const f = fixture()
    f.bridge.pressCharacter.mockResolvedValue(false)
    expect(await loginLotteCard(f.deps)).toContain('no submit or retry')
    expect(f.bridge.submit).not.toHaveBeenCalled()
    expect(f.deps.attempts.failed).toHaveBeenCalledOnce()
  })
  it('does not propagate page exceptions or continue after an origin change', async () => {
    const f = fixture()
    f.bridge.pressCharacter.mockRejectedValue(new Error('private-page-error'))
    expect(await loginLotteCard(f.deps)).not.toContain('private-page-error')
    const moved = fixture()
    moved.setUrl('https://evil.test')
    expect(await loginLotteCard(moved.deps)).toContain('origin changed')
    expect(moved.deps.readSavedPassword).not.toHaveBeenCalled()
  })
})
