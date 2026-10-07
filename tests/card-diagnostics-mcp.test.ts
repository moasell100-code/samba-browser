import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CodexMcpBridge } from '../src/main/agent/codex-mcp'
import {
  startCardDiagnosticsMcp,
  type CardDiagnosticsBackend
} from '../src/main/finance/card-diagnostics-mcp'

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

async function fixture(extra: Partial<CardDiagnosticsBackend> = {}): Promise<{
  client: Client
  backend: CardDiagnosticsBackend
  abort: AbortController
  bridge: CodexMcpBridge
}> {
  const backend: CardDiagnosticsBackend = {
    isBusy: vi.fn(() => false),
    list: vi.fn(() => ({ tabs: [] })),
    openHistory: vi.fn(async (issuer) => ({ issuer, state: 'signed_out' })),
    inspect: vi.fn(async () => ({ state: 'signed_in' })),
    requests: vi.fn(() => ({ requests: [] })),
    dispose: vi.fn(),
    ...extra
  }
  const abort = new AbortController()
  const bridge = await startCardDiagnosticsMcp(backend, abort.signal)
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(bridge.url), {
      requestInit: { headers: { Authorization: `Bearer ${bridge.bearerToken}` } }
    })
  )
  closers.push(async () => {
    await client.close()
    await bridge.close()
  })
  return { client, backend, abort, bridge }
}

describe('read-only card MCP boundary', () => {
  it('exposes bounded cancellation diagnostics without generic request or mutation capability', async () => {
    const probe = vi.fn(async () => ({ detailRows: 1, validAmountRows: 1 }))
    const { client } = await fixture({ cancellationContract: probe })
    const tool = (await client.listTools()).tools.find(
      (entry) => entry.name === 'card_cancellation_contract'
    )!
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    const args = {
      tabId: '00000000-0000-4000-8000-000000000001',
      from: '2026-09-06',
      to: '2026-09-06'
    }
    expect(await client.callTool({ name: tool.name, arguments: args })).toMatchObject({
      content: [{ text: JSON.stringify({ detailRows: 1, validAmountRows: 1 }) }]
    })
    expect(probe).toHaveBeenCalledExactlyOnceWith(args.tabId, args.from, args.to)
    expect(
      (await client.callTool({ name: tool.name, arguments: { ...args, from: 'arbitrary' } }))
        .isError
    ).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
  })
  it('allows existing-approval rechecks only on one supported tab without caller dates or payloads', async () => {
    const reconcile = vi.fn(async () => ({ state: 'checked', checkedDays: 31, reviewRows: 0 }))
    const { client } = await fixture({ reconcile })
    const tool = (await client.listTools()).tools.find(
      (entry) => entry.name === 'card_reconcile_existing'
    )!
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
    const tabId = '00000000-0000-4000-8000-000000000001'
    await client.callTool({ name: tool.name, arguments: { tabId } })
    expect(reconcile).toHaveBeenCalledExactlyOnceWith(tabId)
  })
  it('exposes only four bounded tools over real MCP and rejects arbitrary issuer/URL/actions', async () => {
    const { client, backend } = await fixture()
    const listed = await client.listTools()
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      'card_tabs',
      'card_open_history',
      'card_inspect',
      'card_requests'
    ])
    expect(listed.tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true)
    expect(
      await client.callTool({ name: 'card_open_history', arguments: { issuer: 'lotte_card' } })
    ).toMatchObject({
      content: [{ text: JSON.stringify({ issuer: 'lotte_card', state: 'signed_out' }) }]
    })
    const invalid = await client.callTool({
      name: 'card_open_history',
      arguments: { issuer: 'https://attacker.example' }
    })
    expect(invalid.isError).toBe(true)
    expect(backend.openHistory).toHaveBeenCalledTimes(1)
    await expect(
      client.callTool({ name: 'run_js', arguments: { code: 'secret' } })
    ).rejects.toThrow()
    const badTab = await client.callTool({
      name: 'card_inspect',
      arguments: { tabId: 'not-a-tab' }
    })
    expect(badTab.isError).toBe(true)
    expect(backend.inspect).not.toHaveBeenCalled()
  })

  it('does not expose page exception content and will not interfere with a running agent', async () => {
    const { client, backend } = await fixture()
    vi.mocked(backend.openHistory).mockRejectedValue(new Error('password=secret cookie=private'))
    const result = await client.callTool({
      name: 'card_open_history',
      arguments: { issuer: 'samsung_card' }
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/secret|private|password|cookie/)
    vi.mocked(backend.isBusy).mockReturnValue(true)
    expect((await client.callTool({ name: 'card_tabs', arguments: {} })).isError).toBe(true)
    expect(backend.list).not.toHaveBeenCalled()
  })

  it('disposes observers and revokes requests when aborted', async () => {
    const { client, backend, abort } = await fixture()
    abort.abort()
    expect(backend.dispose).toHaveBeenCalled()
    await expect(client.callTool({ name: 'card_tabs', arguments: {} })).rejects.toThrow()
  })
})
