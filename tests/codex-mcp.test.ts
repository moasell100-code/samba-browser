import { afterEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { startCodexMcp, type CodexMcpBridge } from '../src/main/agent/codex-mcp'

const bridges: CodexMcpBridge[] = []
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()))
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture(
  handler: (label: string) => Promise<string> = async (label) => `page: ${label}`,
  abort = new AbortController()
): Promise<CodexMcpBridge> {
  const tools = [
    tool('get_page', 'Read the current browser page', { label: z.string() }, async ({ label }) => ({
      content: [{ type: 'text' as const, text: await handler(label) }]
    }))
  ]
  const server = Object.assign(createSdkMcpServer({ name: 'samba', version: '0.1.0', tools }), {
    tools
  })
  const bridge = await startCodexMcp({ server, signal: abort.signal })
  bridges.push(bridge)
  return bridge
}

function headers(bridge: CodexMcpBridge, session?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${bridge.bearerToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(session ? { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-03-26' } : {})
  }
}

async function initialize(bridge: CodexMcpBridge): Promise<string> {
  const response = await fetch(bridge.url, {
    method: 'POST',
    headers: headers(bridge),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' }
      }
    })
  })
  expect(response.status).toBe(200)
  expect((await response.json()).result.serverInfo.name).toBe('samba')
  const session = response.headers.get('mcp-session-id')
  expect(session).toBeTruthy()
  return session!
}

function rpc(
  bridge: CodexMcpBridge,
  session: string,
  method: string,
  id: number,
  params = {}
): Promise<Response> {
  return fetch(bridge.url, {
    method: 'POST',
    headers: headers(bridge, session),
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  })
}

describe('Codex per-run browser MCP', () => {
  it('serves the existing SDK tool schema and handler to a real MCP HTTP client', async () => {
    const called: string[] = []
    const bridge = await fixture(async (label) => {
      called.push(label)
      return 'same protected handler'
    })
    const client = new Client({ name: 'codex-test', version: '1' })
    const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
      requestInit: { headers: { Authorization: `Bearer ${bridge.bearerToken}` } }
    })
    try {
      await client.connect(transport)
      const listed = await client.listTools()
      expect(listed.tools.map((entry) => entry.name)).toEqual(['get_page'])
      expect(listed.tools[0].inputSchema.required).toContain('label')
      const result = await client.callTool({ name: 'get_page', arguments: { label: 'current' } })
      expect(result.content).toEqual([{ type: 'text', text: 'same protected handler' }])
      expect(called).toEqual(['current'])
      await expect(client.ping()).resolves.toEqual({})
    } finally {
      await client.close()
    }
  })

  it('rejects missing or wrong bearer tokens, browser origins and forged hosts', async () => {
    const bridge = await fixture()
    const body = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' })
    for (const overrides of [
      { Authorization: '' },
      { Authorization: 'Bearer wrong' },
      { Origin: 'https://hostile.example' },
      { Origin: 'null' },
      { 'Sec-Fetch-Site': 'cross-site' }
    ]) {
      const response = await fetch(bridge.url, {
        method: 'POST',
        headers: { ...headers(bridge), ...overrides },
        body
      })
      expect(response.status, JSON.stringify(overrides)).toBe(
        'Authorization' in overrides ? 401 : 403
      )
      expect(response.headers.has('access-control-allow-origin')).toBe(false)
      await response.text()
    }
    const forgedHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        bridge.url,
        {
          method: 'POST',
          headers: { ...headers(bridge), Host: 'attacker.example' }
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode))
        }
      )
      req.on('error', reject)
      req.end(body)
    })
    expect(forgedHost).toBe(403)
  })

  it('rejects unknown tool/method and malformed or oversized messages without executing tools', async () => {
    const called: string[] = []
    const bridge = await fixture(async (label) => {
      called.push(label)
      return label
    })
    const session = await initialize(bridge)
    const unknown = await rpc(bridge, session, 'tools/call', 1, { name: 'shell', arguments: {} })
    expect((await unknown.json()).error.code).toBe(-32602)
    const resource = await rpc(bridge, session, 'resources/read', 2, { uri: 'file:///private' })
    expect((await resource.json()).error.code).toBe(-32601)
    for (const body of ['[]', '{', JSON.stringify({ jsonrpc: '2.0', method: 'tools/call' })]) {
      const response = await fetch(bridge.url, {
        method: 'POST',
        headers: headers(bridge, session),
        body
      })
      expect(response.status).toBe(400)
      await response.text()
    }
    const big = await fetch(bridge.url, {
      method: 'POST',
      headers: headers(bridge, session),
      body: 'x'.repeat(512 * 1024 + 1)
    })
    expect(big.status).toBe(413)
    await big.text()
    const invalid = await rpc(bridge, session, 'tools/call', 3, {
      name: 'get_page',
      arguments: { label: 1 }
    })
    const invalidBody = await invalid.json()
    expect(invalidBody.result?.isError || invalidBody.error).toBeTruthy()
    expect(called).toEqual([])
  })

  it('serializes tool calls until the previous handler completes', async () => {
    const firstStarted = deferred()
    const releaseFirst = deferred()
    const called: string[] = []
    const bridge = await fixture(async (label) => {
      called.push(label)
      if (label === 'first') {
        firstStarted.resolve()
        await releaseFirst.promise
      }
      return label
    })
    const session = await initialize(bridge)
    const first = rpc(bridge, session, 'tools/call', 1, {
      name: 'get_page',
      arguments: { label: 'first' }
    })
    await firstStarted.promise
    const second = rpc(bridge, session, 'tools/call', 2, {
      name: 'get_page',
      arguments: { label: 'second' }
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(called).toEqual(['first'])
    releaseFirst.resolve()
    const responses = await Promise.all([first, second])
    await Promise.all(responses.map((response) => response.text()))
    expect(called).toEqual(['first', 'second'])
  })

  it('revokes access and discards queued calls immediately when the run is aborted', async () => {
    const abort = new AbortController()
    const firstStarted = deferred()
    const releaseFirst = deferred()
    const called: string[] = []
    const bridge = await fixture(async (label) => {
      called.push(label)
      firstStarted.resolve()
      await releaseFirst.promise
      return label
    }, abort)
    const session = await initialize(bridge)
    const first = rpc(bridge, session, 'tools/call', 1, {
      name: 'get_page',
      arguments: { label: 'first' }
    }).catch(() => null)
    await firstStarted.promise
    const second = rpc(bridge, session, 'tools/call', 2, {
      name: 'get_page',
      arguments: { label: 'second' }
    }).catch(() => null)
    await new Promise((resolve) => setTimeout(resolve, 30))
    abort.abort()
    await bridge.close()
    await expect(rpc(bridge, session, 'ping', 3)).rejects.toThrow()
    releaseFirst.resolve()
    await Promise.all([first, second])
    expect(called).toEqual(['first'])
  })

  it('cancels an individual queued request without executing it or confusing duplicate IDs', async () => {
    const firstStarted = deferred()
    const releaseFirst = deferred()
    const called: string[] = []
    const bridge = await fixture(async (label) => {
      called.push(label)
      if (label === 'first') {
        firstStarted.resolve()
        await releaseFirst.promise
      }
      return label
    })
    const session = await initialize(bridge)
    const first = rpc(bridge, session, 'tools/call', 1, {
      name: 'get_page',
      arguments: { label: 'first' }
    })
    await firstStarted.promise
    const duplicate = await rpc(bridge, session, 'tools/call', 1, {
      name: 'get_page',
      arguments: { label: 'duplicate' }
    })
    expect(duplicate.status).toBe(409)
    await duplicate.text()
    const second = rpc(bridge, session, 'tools/call', 2, {
      name: 'get_page',
      arguments: { label: 'second' }
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const cancelled = await fetch(bridge.url, {
      method: 'POST',
      headers: headers(bridge, session),
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 2, reason: 'no longer needed' }
      })
    })
    expect(cancelled.status).toBe(202)
    releaseFirst.resolve()
    await (await first).text()
    expect((await (await second).json()).error.code).toBe(-32800)
    expect(called).toEqual(['first'])
  })

  it('does not open an endpoint for an already cancelled run and rotates each run token', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(fixture(undefined, abort)).rejects.toThrow('cancelled')
    const one = await fixture()
    const two = await fixture()
    expect(one.bearerToken).not.toBe(two.bearerToken)
    const response = await fetch(two.url, { method: 'POST', headers: headers(one), body: '{}' })
    expect(response.status).toBe(401)
    await response.text()
    await one.close()
    await one.close()
  })
})
