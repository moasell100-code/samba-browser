import { describe, expect, it, vi } from 'vitest'
import type { Tab } from '../src/main/browser/tab-manager'
import { pageBridge } from '../src/main/browser/page-bridge'

function fixture(
  url: string,
  result: unknown,
  after?: string
): { tab: Tab; execute: ReturnType<typeof vi.fn> } {
  let current = url
  const execute = vi.fn(async (_world: number, scripts: { code: string }[]) => {
    expect(scripts).toEqual([{ code: '__samba.cardSession()' }])
    if (after) current = after
    return result
  })
  const tab = {
    view: {
      webContents: {
        getURL: () => current,
        isDestroyed: () => false,
        executeJavaScriptInIsolatedWorld: execute
      }
    }
  } as unknown as Tab
  return { tab, execute }
}

describe('card session fixed bridge', () => {
  it.each([
    'http://www.samsungcard.com/',
    'https://evil.test/',
    'https://www.lottecard.co.kr.evil.test/'
  ])('never inspects unapproved origins %s', async (url) => {
    const f = fixture(url, { issuer: 'samsung_card', state: 'signed_in' })
    expect(await pageBridge.cardSession(f.tab)).toEqual({ issuer: null, state: 'unsupported' })
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('rejects issuer substitution', async () => {
    const f = fixture('https://www.samsungcard.com/', { issuer: 'lotte_card', state: 'signed_in' })
    expect(await pageBridge.cardSession(f.tab)).toEqual({
      issuer: 'samsung_card',
      state: 'unknown'
    })
  })
  it('rejects navigation during the session check', async () => {
    const f = fixture(
      'https://www.lottecard.co.kr/app/LPMCDAA_V100.lc',
      { issuer: 'lotte_card', state: 'signed_in' },
      'https://www.lottecard.co.kr/app/LPMANAA_V200.lc'
    )
    expect(await pageBridge.cardSession(f.tab)).toEqual({ issuer: 'lotte_card', state: 'unknown' })
  })
  it('returns only a validated session result', async () => {
    const result = { issuer: 'samsung_card', state: 'signed_in' }
    const f = fixture('https://www.samsungcard.com/', result)
    expect(await pageBridge.cardSession(f.tab)).toEqual(result)
    expect(f.execute).toHaveBeenCalledOnce()
  })
  it('rejects unexpected fields instead of forwarding page content', async () => {
    const f = fixture('https://www.samsungcard.com/', {
      issuer: 'samsung_card',
      state: 'signed_in',
      pageContent: 'unexpected'
    })
    await expect(pageBridge.cardSession(f.tab)).rejects.toThrow()
  })
  it('never reads Hyundai PIN state on another card issuer', async () => {
    const f = fixture('https://www.samsungcard.com/', { state: 'signed_in' })
    expect(await pageBridge.hyundaiAuth(f.tab)).toEqual({ state: 'unsupported' })
    expect(f.execute).not.toHaveBeenCalled()
  })
})
