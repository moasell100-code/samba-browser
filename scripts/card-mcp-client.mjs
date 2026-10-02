/* eslint-disable @typescript-eslint/explicit-function-return-type -- Standalone JavaScript CLI. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// One temporary local session, never a saved Codex configuration. Neither bearer nor
// MCP session ID is put in arguments, output, errors, or application settings.
async function main() {
  const [sessionName, toolName = 'list', rawArgs = '{}'] = process.argv.slice(2)
  if (!/^[a-z0-9-]{12,64}$/.test(sessionName ?? '')) throw new Error('Invalid session')
  const dir = join(tmpdir(), `jaja-card-mcp-${sessionName}`)
  const descriptor = JSON.parse(await readFile(join(dir, 'endpoint.json'), 'utf8'))
  const endpoint = new URL(descriptor.url)
  if (
    endpoint.protocol !== 'http:' ||
    endpoint.hostname !== '127.0.0.1' ||
    endpoint.pathname !== '/mcp' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    !/^\d+$/.test(endpoint.port) ||
    !/^[A-Za-z0-9_-]{43}$/.test(descriptor.bearerToken) ||
    Date.now() >= descriptor.expiresAt
  )
    throw new Error('Invalid or expired endpoint')
  let session
  try {
    session = JSON.parse(await readFile(join(dir, 'client-session.json'), 'utf8')).id
  } catch {
    /* First call. */
  }
  const headers = {
    Authorization: `Bearer ${descriptor.bearerToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream'
  }
  async function send(message, activeSession) {
    const res = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(45_000),
      headers: {
        ...headers,
        ...(activeSession
          ? { 'Mcp-Session-Id': activeSession, 'MCP-Protocol-Version': '2025-03-26' }
          : {})
      },
      body: JSON.stringify(message)
    })
    if (!res.ok) throw new Error('MCP request failed')
    return res
  }
  if (!session) {
    const response = await send({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'card-readonly-cli', version: '1' }
      }
    })
    const initialized = await response.json()
    if (!['jaja-card-readonly', 'jaja-card-collector'].includes(initialized.result?.serverInfo?.name))
      throw new Error('Unexpected MCP server')
    session = response.headers.get('mcp-session-id')
    if (!session) throw new Error('No MCP session')
    await writeFile(join(dir, 'client-session.json'), JSON.stringify({ id: session }), {
      mode: 0o600,
      flag: 'wx'
    })
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' }, session)
  }
  const response = await send(
    {
      jsonrpc: '2.0',
      id: Date.now(),
      method: toolName === 'list' ? 'tools/list' : 'tools/call',
      ...(toolName === 'list' ? {} : { params: { name: toolName, arguments: JSON.parse(rawArgs) } })
    },
    session
  )
  const result = await response.json()
  if (result.error) throw new Error('MCP rejected the request')
  if (toolName === 'list') {
    console.log(
      JSON.stringify({
        tools: result.result.tools.map(({ name, description }) => ({ name, description }))
      })
    )
  } else {
    console.log(JSON.stringify(result.result))
  }
}

main().catch(() => {
  console.error('Card MCP call failed or session expired')
  process.exitCode = 1
})
