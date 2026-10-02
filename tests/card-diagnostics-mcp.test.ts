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

async function fixture(): Promise<{
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
    dispose: vi.fn()
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
