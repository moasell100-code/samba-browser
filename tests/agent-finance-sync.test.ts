import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabManager, Tab } from '../src/main/browser/tab-manager'
import type { ToolContext } from '../src/main/agent/tools'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({
    name,
    description,
    schema,
    handler
  }),
  createSdkMcpServer: (o: unknown) => o
}))
vi.mock('../src/main/browser/page-bridge', () => ({ pageBridge: {} }))
vi.mock('../src/main/finance/card-agent-sync', () => ({ CARD_AGENT_TOOL_TIMEOUT_MS: 480_000 }))

import { createSambaTools, SAMBA_TOOL_NAMES } from '../src/main/agent/tools'

const safeReceipt = {
  ok: true as const,
  issuer: 'samsung_card' as const,
  range: { from: '2026-09-29', to: '2026-10-02' },
  pages: 4,
  totalRows: 2,
  insertedRows: 1,
  updatedRows: 0,
  skippedRows: 1,
  reviewRows: 0,
  duplicateBatch: false,
  complete: true
}
function setup(options: { disabled?: boolean; mode?: ToolContext['mode']; popup?: boolean } = {}): {
  tool: ReturnType<typeof createSambaTools>['tools'][number] | undefined
  call: () => Promise<string>
  tab: Tab
  sync: ReturnType<typeof vi.fn<() => Promise<typeof safeReceipt>>>
  onStep: ReturnType<typeof vi.fn>
  dialog: ReturnType<typeof vi.fn>
} {
  const tab = {
    id: 'card',
    view: {
      webContents: {
        getURL: () => 'https://www.samsungcard.com/personal/card/activity/UHPPRP0801M0.jsp'
      }
    }
  } as unknown as Tab
  const sync = vi.fn(async () => safeReceipt)
  const onStep = vi.fn()
  const dialog = vi.fn(() => ({ type: 'alert', message: 'PRIVATE CARD DIALOG' }))
  const ctx: ToolContext = {
    tabs: {
      active: () => tab,
      agentTarget: () => (options.popup ? { ...tab, id: 'popup' } : tab),
      list: () => [],
      takeDialogMessage: dialog
    } as unknown as TabManager,
    syncFinance: options.disabled ? undefined : sync,
    mode: options.mode ?? 'guard',
    dangerWords: [],
    finalConfirm: false,
    tick: () => null,
    confirm: vi.fn(async () => true),
    onStep
  }
  const server = createSambaTools(ctx)
  const tool = server.tools.find((t) => t.name === 'sync_finance_recent')
  const call = async (): Promise<string> => {
    const result = await tool!.handler({})
    return (result as { content: { text: string }[] }).content[0].text
  }
  return { tool, call, tab, sync, onStep, dialog }
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.useRealTimers())

describe('sync_finance_recent agent tool', () => {
  it('is allowlisted but absent without the configured callback', () => {
    expect(SAMBA_TOOL_NAMES).toContain('mcp__samba__sync_finance_recent')
    expect(setup({ disabled: true }).tool).toBeUndefined()
  })

  it('blocks read-only mode before invoking the importer', async () => {
    const s = setup({ mode: 'read_only' })
    expect(await s.call()).toBe('refused: read-only mode')
    expect(s.sync).not.toHaveBeenCalled()
    expect(s.onStep).toHaveBeenCalledWith(expect.any(String), false)
  })

  it('does not silently use a background parent tab while a popup is selected', async () => {
    const s = setup({ popup: true })
    expect(await s.call()).toMatch(/^refused:/)
    expect(s.sync).not.toHaveBeenCalled()
  })

  it('returns only the safe receipt and discards pending dialog text', async () => {
    const s = setup()
    expect(JSON.parse(await s.call())).toEqual(safeReceipt)
    expect(s.sync).toHaveBeenCalledWith(s.tab)
    expect(s.dialog).toHaveBeenCalledOnce()
  })

  it('masks unexpected callback errors without reporting success', async () => {
    const s = setup()
    s.sync.mockRejectedValueOnce(new Error('PRIVATE token account merchant'))
    expect(await s.call()).toBe('error: finance sync unavailable')
    expect(s.onStep).toHaveBeenCalledWith(expect.any(String), false)
  })

  it('keeps deterministic failures visible to the model and progress UI', async () => {
    const s = setup()
    s.sync.mockResolvedValueOnce({ ok: false, reason: 'login_required' } as never)
    expect(await s.call()).toBe('refused: finance sync login_required')
    expect(s.onStep).toHaveBeenCalledWith(expect.any(String), false)
  })

  it('allows a bounded multi-page run beyond the generic 90-second deadline', async () => {
    vi.useFakeTimers()
    const s = setup()
    s.sync.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(safeReceipt), 95_000))
    )
    const pending = s.call()
    await vi.advanceTimersByTimeAsync(95_000)
    expect(JSON.parse(await pending)).toEqual(safeReceipt)
  })
})
