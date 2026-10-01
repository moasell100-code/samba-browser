import { describe, expect, it, vi } from 'vitest'
import type { HyundaiAuthSnapshot } from '../src/shared/hyundai-auth'
import {
  HYUNDAI_LOGIN_URL,
  HYUNDAI_PIN_ALREADY_TRIED,
  isHyundaiLoginUrl,
  loginHyundaiCard
} from '../src/main/finance/hyundai-login'
import type { HyundaiAttempts } from '../src/main/finance/hyundai-attempts'

// Generated dummy data only, not a real credential or captured banking fixture.
const dummyPin = Array.from({ length: 6 }, (_, index) => String(index)).join('')

// Preserve inferred Vitest mock signatures in this synthetic test fixture.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture() {
  let url = HYUNDAI_LOGIN_URL
  let filled = 0
  let opened = false
  let reads = 0
  let initial: HyundaiAuthSnapshot['state'] = 'pin_ready'
  let end: HyundaiAuthSnapshot['state'] = 'signed_in'
  let priorDigits: NonNullable<HyundaiAuthSnapshot['digits']> = []
  const entered: string[] = []
  const attempts: HyundaiAttempts = {
    begin: vi.fn(() => true),
    failed: vi.fn(),
    succeeded: vi.fn(),
    clearSignedInProfile: vi.fn()
  }
  const read = vi.fn(async (): Promise<HyundaiAuthSnapshot> => {
    reads++
    if (initial !== 'pin_ready') return { state: initial }
    if (filled === 6)
      return end === 'pin_ready' ? { state: end, inputId: 1, filled } : { state: end }
    // Every observation reshuffles the IDs. Reusing any previous layout sends the wrong key.
    priorDigits = Array.from({ length: 10 }, (_, index) => ({
      digit: String(index),
      id: reads * 10 + index + 2
    }))
    return { state: 'pin_ready', inputId: 1, filled, ...(opened ? { digits: priorDigits } : {}) }
  })
  const bridge = {
    url: () => url,
    read,
    navigate: vi.fn(async (next: string) => {
      url = next
      initial = 'pin_ready'
    }),
    waitForLoad: vi.fn(async () => undefined),
    pressOnce: vi.fn(async (id: number) => {
      if (id === 1) {
        opened = true
        return 'ok'
      }
      const key = priorDigits.find((key) => key.id === id)
      if (!key) throw new Error('stale keypad')
      entered.push(key.digit)
      filled++
      return 'ok'
    })
  }
  const deps = {
    bridge,
    attempts,
    attempt: {
      accountId: 7,
      itemId: 11,
      revision: 'opaque-encrypted-revision',
      profile: 'unit-profile'
    },
    readSavedPin: vi.fn((): string | null => dummyPin),
    autoSubmit: true,
    tick: vi.fn((): string | null => null),
    verifyTarget: vi.fn((): string | null => null),
    sleep: vi.fn(async () => undefined)
  }
  return {
    deps,
    entered,
    bridge,
    attempts,
    setState: (value: HyundaiAuthSnapshot['state']) => {
      initial = value
    },
    setEnd: (value: HyundaiAuthSnapshot['state']) => {
      end = value
    },
    setFilled: (value: number) => {
      filled = value
    },
    setUrl: (value: string) => {
      url = value
    }
  }
}

describe('Hyundai PIN login orchestration', () => {
  it('enters exactly once per fresh shuffled key and verifies the resulting session', async () => {
    const f = fixture()
    expect(await loginHyundaiCard(f.deps)).toContain('session verified')
    expect(f.entered.join('')).toBe(dummyPin)
    expect(f.bridge.pressOnce).toHaveBeenCalledTimes(7)
    expect(f.attempts.begin).toHaveBeenCalledOnce()
    expect(f.attempts.succeeded).toHaveBeenCalledOnce()
    expect(f.attempts.failed).not.toHaveBeenCalled()
  })

  it('reuses a verified session without reading the secret, even with submit disabled', async () => {
    const f = fixture()
    f.setState('signed_in')
    f.deps.autoSubmit = false
    expect(await loginHyundaiCard(f.deps)).toContain('session verified')
    expect(f.deps.readSavedPin).not.toHaveBeenCalled()
    expect(f.bridge.pressOnce).not.toHaveBeenCalled()
  })

  it('visits the public entry once for an expired unknown page', async () => {
    const f = fixture()
    f.setState('unknown')
    f.setUrl('https://www.hyundaicard.com/cpa/session-expired.hc')
    expect(await loginHyundaiCard(f.deps)).toContain('session verified')
    expect(f.bridge.navigate).toHaveBeenCalledExactlyOnceWith(HYUNDAI_LOGIN_URL)
  })

  it('does not type or read a secret when automatic submission is disabled', async () => {
    const f = fixture()
    f.deps.autoSubmit = false
    expect(await loginHyundaiCard(f.deps)).toContain('submit is disabled')
    expect(f.deps.readSavedPin).not.toHaveBeenCalled()
    expect(f.bridge.pressOnce).not.toHaveBeenCalled()
    expect(f.attempts.begin).not.toHaveBeenCalled()
  })

  it.each(['registration_required', 'unsupported', 'additional_auth', 'pin_error'] as const)(
    'stops on %s without pressing or navigating',
    async (state) => {
      const f = fixture()
      f.setState(state)
      expect(await loginHyundaiCard(f.deps)).not.toContain('session verified')
      expect(f.bridge.pressOnce).not.toHaveBeenCalled()
      expect(f.bridge.navigate).not.toHaveBeenCalled()
    }
  )

  it.each([null, '', 'too-short', dummyPin + '9'])(
    'does not use a missing or malformed stored PIN',
    async (value) => {
      const f = fixture()
      f.deps.readSavedPin.mockReturnValue(value)
      await loginHyundaiCard(f.deps)
      expect(f.bridge.pressOnce).not.toHaveBeenCalled()
    }
  )

  it('does not append to a partially filled PIN', async () => {
    const f = fixture()
    f.setFilled(2)
    expect(await loginHyundaiCard(f.deps)).toContain('not empty')
    expect(f.bridge.pressOnce).not.toHaveBeenCalled()
  })

  it.each(['missing', 'duplicate-digit', 'duplicate-id', 'frame-id'])(
    'refuses a %s keypad before any secret input',
    async (bad) => {
      const f = fixture()
      const original = f.bridge.read.getMockImplementation()!
      f.bridge.read.mockImplementation(async () => {
        const value = await original()
        if (value.digits) {
          if (bad === 'missing') value.digits.pop()
          if (bad === 'duplicate-digit') value.digits[1].digit = value.digits[0].digit
          if (bad === 'duplicate-id') value.digits[1].id = value.digits[0].id
          if (bad === 'frame-id') value.digits[1].id = 100_001
        }
        return value
      })
      expect(await loginHyundaiCard(f.deps)).toContain('keypad or input count changed')
      expect(f.entered).toHaveLength(0)
      expect(f.attempts.begin).not.toHaveBeenCalled()
    }
  )

  it('never retries a ignored or duplicate key press', async () => {
    const f = fixture()
    const press = f.bridge.pressOnce.getMockImplementation()!
    f.bridge.pressOnce.mockImplementation(async (id) => {
      const result = await press(id)
      if (id !== 1) f.setFilled(0)
      return result
    })
    expect(await loginHyundaiCard(f.deps)).toContain('input count changed')
    expect(f.entered).toHaveLength(1)
    expect(f.attempts.failed).toHaveBeenCalledOnce()
  })

  it('stops before a digit if the URL changes during the fresh DOM read', async () => {
    const f = fixture()
    const original = f.bridge.read.getMockImplementation()!
    f.bridge.read.mockImplementation(async () => {
      const value = await original()
      if (value.digits) f.setUrl('https://other.example/')
      return value
    })
    await loginHyundaiCard(f.deps)
    expect(f.entered).toHaveLength(0)
  })

  it('observes stop/tick before further mutations and retains the failure latch', async () => {
    const f = fixture()
    f.deps.tick.mockImplementation(() => (f.entered.length === 2 ? 'stopped' : null))
    expect(await loginHyundaiCard(f.deps)).toBe('stopped')
    expect(f.entered).toHaveLength(2)
    expect(f.attempts.failed).toHaveBeenCalledOnce()
  })

  it('requires the durable latch before pressing the first digit', async () => {
    const f = fixture()
    vi.mocked(f.attempts.begin).mockReturnValue(false)
    expect(await loginHyundaiCard(f.deps)).toBe(HYUNDAI_PIN_ALREADY_TRIED)
    expect(f.entered).toHaveLength(0)
  })

  it.each(['pin_error', 'additional_auth', 'unknown'] as const)(
    'does not resubmit after %s or uncertain completion',
    async (state) => {
      const f = fixture()
      f.setEnd(state)
      const result = await loginHyundaiCard(f.deps)
      expect(result).not.toContain('session verified')
      expect(result).not.toContain(dummyPin)
      expect(f.entered).toHaveLength(6)
      expect(f.attempts.failed).toHaveBeenCalledOnce()
    }
  )

  it('suppresses raw page exceptions and does not press again', async () => {
    const f = fixture()
    f.bridge.pressOnce.mockRejectedValue(new Error(dummyPin))
    const result = await loginHyundaiCard(f.deps)
    expect(result).toContain('could not be verified')
    expect(result).not.toContain(dummyPin)
    expect(f.bridge.pressOnce).toHaveBeenCalledTimes(1)
  })
})

it.each([
  'http://www.hyundaicard.com/',
  'https://evil.hyundaicard.com/',
  'https://hyundaicard.com.evil.test/',
  'https://hyundaicard.com:8443/',
  'https://user@hyundaicard.com/'
])('rejects nonallowlisted URL %s', (url) => {
  expect(isHyundaiLoginUrl(url)).toBe(false)
})
