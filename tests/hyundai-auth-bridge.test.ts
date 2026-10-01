import { describe, expect, it, vi } from 'vitest'
import type { Tab } from '../src/main/browser/tab-manager'
vi.mock('../src/main/browser/frame-channel', () => ({ callFrameOp: vi.fn() }))
const { pageBridge } = await import('../src/main/browser/page-bridge')
function fixture(
  url: string,
  result: unknown,
  changeUrl?: string
): { execute: ReturnType<typeof vi.fn>; tab: Tab } {
  let current = url
  const execute = vi.fn(async (_world, scripts) => {
    expect(scripts).toEqual([{ code: '__samba.hyundaiAuth()' }])
    if (changeUrl) current = changeUrl
    return result
  })
  return {
    execute,
    tab: {
      view: {
        webContents: {
          getURL: () => current,
          isDestroyed: () => false,
          executeJavaScriptInIsolatedWorld: execute
        }
      }
    } as unknown as Tab
  }
}
describe('Hyundai auth bridge', () => {
  it.each([
    'http://www.hyundaicard.com/',
    'https://www.hyundaicard.com.evil.test/',
    'https://www.hyundaicard.com:444/',
    'https://other.hyundaicard.com/',
    'https://user:secret@www.hyundaicard.com/'
  ])('never queries a disallowed origin %s', async (url) => {
    const f = fixture(url, { state: 'pin_ready' })
    expect(await pageBridge.hyundaiAuth(f.tab)).toEqual({ state: 'unsupported' })
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('strips unexpected page data and rejects navigation during status read', async () => {
    const f = fixture('https://www.hyundaicard.com/index.jsp', {
      state: 'signed_in',
      secret: 'never-return'
    })
    expect(await pageBridge.hyundaiAuth(f.tab)).toEqual({ state: 'signed_in' })
    const moved = fixture(
      'https://www.hyundaicard.com/index.jsp',
      { state: 'signed_in' },
      'https://evil.test/'
    )
    expect(await pageBridge.hyundaiAuth(moved.tab)).toEqual({ state: 'unknown' })
  })
})
