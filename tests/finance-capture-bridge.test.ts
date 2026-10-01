import { describe, expect, it, vi } from 'vitest'
import type { Tab } from '../src/main/browser/tab-manager'
import type { FinanceFrameCapture } from '../src/shared/finance-capture'

vi.mock('../src/main/browser/frame-channel', () => ({
  callFrameOp: async (frame: { fail?: boolean; result: unknown }, op: { op: string }) => {
    expect(op).toEqual({ op: 'financeTables' })
    if (frame.fail) throw new Error('frame unavailable')
    return frame.result
  }
}))

const { pageBridge } = await import('../src/main/browser/page-bridge')
const { captureCurrentFinancePage } = await import('../src/main/finance/capture')
const { FinanceCaptureStore } = await import('../src/main/finance/capture-store')

function frameResult(): FinanceFrameCapture {
  return { origin: 'https://www.hyundaicard.com', pathname: '/history', tables: [] }
}

function fakeTab(
  url: string,
  frames: unknown[] = [],
  navigateOnRead = false
): { tab: Tab; execute: ReturnType<typeof vi.fn> } {
  let current = url
  const mainFrame: { framesInSubtree: unknown[] } = { framesInSubtree: [] }
  mainFrame.framesInSubtree = [mainFrame, ...frames]
  const execute = vi.fn(async (_world: number, scripts: { code: string }[]) => {
    expect(scripts).toEqual([{ code: '__samba.financeTables()' }])
    if (navigateOnRead) current = 'https://evil.test/'
    return frameResult()
  })
  const tab = {
    view: {
      webContents: {
        getURL: () => current,
        isDestroyed: () => false,
        mainFrame,
        executeJavaScriptInIsolatedWorld: execute
      }
    }
  } as unknown as Tab
  return { tab, execute }
}

describe('finance capture bridge', () => {
  it('does not execute any page code on an unapproved origin', async () => {
    const { tab, execute } = fakeTab('https://evil.test/')
    await expect(pageBridge.financeTables(tab)).rejects.toThrow('finance_origin_not_allowed')
    expect(execute).not.toHaveBeenCalled()
  })
  it('rejects navigation during capture', async () => {
    const { tab } = fakeTab('https://www.hyundaicard.com/history', [], true)
    await expect(pageBridge.financeTables(tab)).rejects.toThrow('finance_page_changed')
  })
  it('counts failed and disallowed frames and retains only allowed frame data', async () => {
    const { tab } = fakeTab('https://www.hyundaicard.com/history', [
      { url: 'https://www.hyundaicard.com/history', result: frameResult() },
      { url: 'https://www.hyundaicard.com/history', fail: true },
      { url: 'https://third-party.test/' },
      { url: 'about:blank' }
    ])
    const captured = await pageBridge.financeTables(tab)
    expect(captured.frames).toHaveLength(2)
    expect(captured.failedFrames).toBe(1)
    expect(captured.skippedFrames).toBe(2)
    const receipt = await captureCurrentFinancePage(tab, new FinanceCaptureStore())
    expect(receipt.previewOnly).toBe(true)
    expect(receipt.issues).toContain('frame_incomplete')
  })
})
