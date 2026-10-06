import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  startCardDiagnosticsMcp,
  type CardDiagnosticsBackend
} from '../src/main/finance/card-diagnostics-mcp'

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})
async function fixture(): Promise<{ client: Client; backend: CardDiagnosticsBackend }> {
  const backend: CardDiagnosticsBackend = {
    isBusy: vi.fn(() => false),
    list: vi.fn(() => ({ tabs: [] })),
    openHistory: vi.fn(),
    inspect: vi.fn(),
    requests: vi.fn(),
    dispose: vi.fn(),
    exportHistory: vi.fn(async () => ({
      state: 'saved',
      issuer: 'lotte_card',
      range: { from: '2026-07-01', to: '2026-07-31' },
      bytes: 100,
      expectedRows: null,
      path: 'C:/synthetic/exports/lotte.xls',
      sha256: 'synthetic-hash'
    }))
  }
  const abort = new AbortController()
  const bridge = await startCardDiagnosticsMcp(backend, abort.signal)
  const client = new Client({ name: 'synthetic-excel-client', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(bridge.url), {
      requestInit: { headers: { Authorization: `Bearer ${bridge.bearerToken}` } }
    })
  )
  closers.push(async () => {
    await client.close()
    await bridge.close()
  })
  return { client, backend }
}
const ARGS = { tabId: '00000000-0000-4000-8000-000000000001', from: '2026-07-01', to: '2026-07-31' }

describe('card workbook MCP boundary', () => {
  it('exposes only date/tab/scope input and marks the download as a local write', async () => {
    const { client, backend } = await fixture()
    const tool = (await client.listTools()).tools.find(
      (tool) => tool.name === 'card_export_history'
    )!
    expect(Object.keys(tool.inputSchema.properties!)).toEqual(['tabId', 'from', 'to', 'scope'])
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
    const result = await client.callTool({ name: 'card_export_history', arguments: ARGS })
    expect(result.isError).not.toBe(true)
    expect(backend.exportHistory).toHaveBeenCalledWith(ARGS.tabId, ARGS.from, ARGS.to, undefined)
    expect(JSON.stringify(result)).not.toMatch(/password|cookie|accountNumber|worksheet|cellValue/)
  })

  it.each([
    { tabId: 'https://example.invalid' },
    { from: '2026-07-01&private=value' },
    { scope: 'https://example.invalid/export' }
  ])('rejects invalid bounded arguments before backend use (%j)', async (patch) => {
    const { client, backend } = await fixture()
    const result = await client.callTool({
      name: 'card_export_history',
      arguments: { ...ARGS, ...patch }
    })
    expect(result.isError).toBe(true)
    expect(backend.exportHistory).not.toHaveBeenCalled()
  })

  it('does not pass extra URL, request body or output directory arguments to the exporter', async () => {
    const { client, backend } = await fixture()
    await client.callTool({
      name: 'card_export_history',
      arguments: {
        ...ARGS,
        url: 'https://example.invalid',
        body: 'synthetic-private-body',
        directory: 'C:/escape'
      }
    })
    expect(backend.exportHistory).toHaveBeenCalledWith(ARGS.tabId, ARGS.from, ARGS.to, undefined)
  })

  it('sanitizes exporter exceptions and blocks a busy agent session', async () => {
    const { client, backend } = await fixture()
    vi.mocked(backend.exportHistory!).mockRejectedValue(
      new Error('synthetic-private-cookie-or-rows')
    )
    const result = await client.callTool({ name: 'card_export_history', arguments: ARGS })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain('synthetic-private-cookie-or-rows')
    vi.mocked(backend.isBusy).mockReturnValue(true)
    const blocked = await client.callTool({ name: 'card_export_history', arguments: ARGS })
    expect(blocked.isError).toBe(true)
    expect(backend.exportHistory).toHaveBeenCalledTimes(1)
  })
})
