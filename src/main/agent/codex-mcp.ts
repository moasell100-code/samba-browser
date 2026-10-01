import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

const MAX_BODY_BYTES = 512 * 1024
const MAX_PENDING_CALLS = 32
const REQUEST_METHODS = new Set(['initialize', 'ping', 'tools/list', 'tools/call'])
const NOTIFICATION_METHODS = new Set(['notifications/initialized', 'notifications/cancelled'])

type RequestId = string | number
type Message = { jsonrpc: '2.0'; method: string; id?: RequestId; params?: Record<string, unknown> }

export interface CodexMcpInput {
  /** The very same server/context as the runner: approvals, vault gates and counters stay in force. */
  server: { instance: Pick<McpServer, 'connect' | 'close'>; tools: readonly { name: string }[] }
  signal: AbortSignal
}

export interface CodexMcpBridge {
  url: string
  /** Pass only through the child process environment, never through CLI args or a saved config. */
  bearerToken: string
  close: () => Promise<void>
}

function reply(res: ServerResponse, status: number, message: string): void {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify({ error: message }))
}

function rpcError(res: ServerResponse, id: RequestId | null, code: number, message: string): void {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }))
}

function hasToken(req: IncomingMessage, expected: Buffer): boolean {
  const value = req.headers.authorization
  if (!value?.startsWith('Bearer ')) return false
  const actual = Buffer.from(value.slice(7))
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

async function readMessage(req: IncomingMessage): Promise<Message> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(bytes)
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid request')
  const record = body as Record<string, unknown>
  if (record.jsonrpc !== '2.0' || typeof record.method !== 'string')
    throw new Error('invalid request')
  if (
    record.id !== undefined &&
    typeof record.id !== 'string' &&
    !(typeof record.id === 'number' && Number.isFinite(record.id))
  ) {
    throw new Error('invalid request')
  }
  if (
    record.params !== undefined &&
    (!record.params || typeof record.params !== 'object' || Array.isArray(record.params))
  ) {
    throw new Error('invalid request')
  }
  return record as Message
}

/** A single run's MCP endpoint; it does not reuse the app's persistent extension bridge. */
export async function startCodexMcp({
  server: sdk,
  signal
}: CodexMcpInput): Promise<CodexMcpBridge> {
  if (signal.aborted) throw new Error('Codex browser session cancelled')
  const bearerToken = randomBytes(32).toString('base64url')
  const tokenBytes = Buffer.from(bearerToken)
  const allowedTools = new Set(sdk.tools.map((tool) => tool.name))
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true
  })
  const sockets = new Set<Socket>()
  const pendingIds = new Set<RequestId>()
  const cancelledIds = new Set<RequestId>()
  const completions = new Map<RequestId, () => void>()
  let closed = false
  let closePromise: Promise<void> | undefined
  let authority = ''
  let queue = Promise.resolve()

  // Release the queue on the protocol reply, not on a client socket closing. An in-flight
  // browser action may still be finishing after its client disappears.
  const send = transport.send.bind(transport)
  transport.send = async (message, options) => {
    try {
      await send(message, options)
    } finally {
      if (
        'id' in message &&
        message.id !== undefined &&
        ('result' in message || 'error' in message)
      ) {
        completions.get(message.id)?.()
        completions.delete(message.id)
      }
    }
  }
  await sdk.instance.connect(transport)
  const dispatch = transport.onmessage
  transport.onmessage = (message, extra) => {
    if (closed) return
    if ('method' in message && message.method === 'notifications/cancelled') {
      const id = message.params?.requestId
      if ((typeof id === 'string' || typeof id === 'number') && pendingIds.has(id)) {
        cancelledIds.add(id)
      }
    }
    if (!('method' in message) || message.method !== 'tools/call' || !('id' in message)) {
      dispatch?.(message, extra)
      return
    }
    queue = queue
      .then(async () => {
        if (closed) return
        if (cancelledIds.has(message.id)) {
          await transport.send({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32800, message: 'Request cancelled' }
          })
          return
        }
        await new Promise<void>((resolve) => {
          completions.set(message.id, resolve)
          dispatch?.(message, extra)
        })
      })
      .catch(() => undefined)
  }

  const http = createServer((req, res) => {
    void handle(req, res).catch(() => reply(res, 500, 'MCP request failed'))
  })
  http.headersTimeout = 15_000
  http.requestTimeout = 30_000
  http.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store')
    if (closed || signal.aborted) return reply(res, 410, 'Session closed')
    if (req.headers.host !== authority || req.headers.origin !== undefined) {
      return reply(res, 403, 'Local CLI requests only')
    }
    if (req.headers['sec-fetch-site'] !== undefined)
      return reply(res, 403, 'Local CLI requests only')
    if (!hasToken(req, tokenBytes)) return reply(res, 401, 'Unauthorized')
    if (req.url !== '/mcp') return reply(res, 404, 'Not found')
    if (req.method === 'DELETE') {
      await transport.handleRequest(req, res)
      return
    }
    // This server sends no unsolicited events; MCP permits 405 for the optional SSE GET.
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, DELETE')
      return reply(res, 405, 'Method not allowed')
    }
    const length = Number(req.headers['content-length'] ?? 0)
    if (length > MAX_BODY_BYTES) return reply(res, 413, 'Request too large')
    let message: Message
    try {
      message = await readMessage(req)
    } catch (error) {
      return reply(
        res,
        error instanceof Error && error.message === 'body too large' ? 413 : 400,
        'Invalid request'
      )
    }
    if (closed || signal.aborted) return reply(res, 410, 'Session closed')
    if (message.id === undefined) {
      if (!NOTIFICATION_METHODS.has(message.method))
        return reply(res, 400, 'Unsupported notification')
    } else if (!REQUEST_METHODS.has(message.method)) {
      return rpcError(res, message.id, -32601, 'Method not available')
    }
    if (message.method === 'tools/call') {
      if (typeof message.params?.name !== 'string' || !allowedTools.has(message.params.name)) {
        return rpcError(res, message.id ?? null, -32602, 'Tool not available')
      }
    }
    const id = message.id
    if (id !== undefined) {
      if (pendingIds.has(id)) return reply(res, 409, 'Request ID already in use')
      if (pendingIds.size >= MAX_PENDING_CALLS) return reply(res, 429, 'Too many pending requests')
      pendingIds.add(id)
    }
    try {
      await transport.handleRequest(req, res, message)
    } finally {
      if (id !== undefined) {
        pendingIds.delete(id)
        cancelledIds.delete(id)
      }
    }
  }

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    // Revocation is synchronous, before any cleanup await.
    closed = true
    tokenBytes.fill(0)
    signal.removeEventListener('abort', onAbort)
    for (const resolve of completions.values()) resolve()
    completions.clear()
    for (const socket of sockets) socket.destroy()
    closePromise = Promise.all([
      new Promise<void>((resolve) => http.close(() => resolve())),
      sdk.instance.close().catch(() => undefined)
    ]).then(() => undefined)
    return closePromise
  }
  const onAbort = (): void => {
    void close()
  }
  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(0, '127.0.0.1', () => {
        http.removeListener('error', reject)
        resolve()
      })
    })
    const address = http.address()
    if (!address || typeof address === 'string') throw new Error('Cannot open local MCP endpoint')
    authority = `127.0.0.1:${address.port}`
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) throw new Error('Codex browser session cancelled')
    return { url: `http://${authority}/mcp`, bearerToken, close }
  } catch (error) {
    await close()
    throw error
  }
}
