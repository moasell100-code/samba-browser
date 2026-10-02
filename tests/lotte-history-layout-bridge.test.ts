import { describe, expect, it, vi } from 'vitest'
import type { Tab } from '../src/main/browser/tab-manager'
vi.mock('electron', () => ({ BrowserWindow: {}, app: { getPath: () => '' } }))
vi.mock('../src/main/browser/frame-channel', () => ({ callFrameOp: vi.fn() }))
const { pageBridge } = await import('../src/main/browser/page-bridge')
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture(result: unknown = { state: 'root_missing' }) {
  let url = 'https://www.lottecard.co.kr/app/LPMCDAA_V100.lc'
  const execute = vi.fn(async () => result)
  return {
    tab: {
      view: {
        webContents: {
          getURL: () => url,
          isDestroyed: () => false,
          executeJavaScriptInIsolatedWorld: execute
        }
      }
    } as unknown as Tab,
    execute,
    setUrl: (next: string) => {
      url = next
    }
  }
}
describe('Lotte structure-only diagnostic bridge', () => {
  it('makes a fixed main-frame call without auth bypass or data-capture calls', async () => {
    const f = fixture()
    expect(await pageBridge.lotteHistoryLayout(f.tab)).toEqual({ state: 'root_missing' })
    expect(f.execute).toHaveBeenCalledWith(999, [{ code: '__samba.lotteHistoryLayout()' }])
    f.setUrl('https://www.lottecard.co.kr/app/LPMANAA_V200.lc')
    expect(await pageBridge.lotteHistoryLayout(f.tab)).toEqual({ state: 'unsupported' })
    expect(f.execute).toHaveBeenCalledOnce()
  })
  it('rejects unexpected raw fields and navigation while masking failures', async () => {
    const raw = fixture({ state: 'ok', text: 'private' })
    expect(await pageBridge.lotteHistoryLayout(raw.tab)).toEqual({ state: 'unavailable' })
    const moved = fixture()
    moved.execute.mockImplementation(async () => {
      moved.setUrl('https://evil.test')
      return { state: 'root_missing' }
    })
    expect(await pageBridge.lotteHistoryLayout(moved.tab)).toEqual({ state: 'unavailable' })
    const error = fixture()
    error.execute.mockRejectedValue(new Error('private'))
    expect(await pageBridge.lotteHistoryLayout(error.tab)).toEqual({ state: 'unavailable' })
  })
})
