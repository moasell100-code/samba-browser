import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { startCodexMcp, type CodexMcpBridge } from '../agent/codex-mcp'

export const CARD_DIAGNOSTIC_ISSUERS = ['hyundai_card', 'samsung_card', 'lotte_card'] as const
export type CardDiagnosticIssuer = (typeof CARD_DIAGNOSTIC_ISSUERS)[number]

/** No credential, generic browser action, arbitrary URL, or request replay capability. */
export interface CardDiagnosticsBackend {
  isBusy(): boolean
  list(): unknown
  openHistory(issuer: CardDiagnosticIssuer): Promise<unknown>
  inspect(tabId: string): Promise<unknown>
  requests(tabId: string): unknown
  queryContract?(tabId: string): Promise<unknown>
  login?(tabId: string): Promise<unknown>
  collect?(tabId: string, save: boolean): Promise<unknown>
  dispose(): void
}

export async function startCardDiagnosticsMcp(
  backend: CardDiagnosticsBackend,
  signal: AbortSignal
): Promise<CodexMcpBridge> {
  const server = new McpServer({ name: 'jaja-card-collector', version: '1.1.0' })
  const tools: Array<{ name: string }> = []
  function register(
    name: string,
    description: string,
    inputSchema: z.ZodRawShape,
    callback: (args: Record<string, unknown>) => unknown | Promise<unknown>,
    readOnlyHint = true
  ): void {
    tools.push({ name })
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        annotations: { readOnlyHint, destructiveHint: false, openWorldHint: true }
      },
      async (args) => {
        if (signal.aborted || backend.isBusy()) {
          return {
            isError: true,
            content: [
              { type: 'text' as const, text: 'Card diagnostics unavailable: closed or agent busy' }
            ]
          }
        }
        try {
          const value = await callback(args)
          return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
        } catch (error) {
          // Errors from Electron/pages may contain URLs, inputs, or response bodies.
          const safeErrors = new Set([
            'Card tab changed',
            'Card tab unavailable',
            'Card diagnostics unavailable',
            'Card observation unavailable',
            'No observer'
          ])
          const message =
            error instanceof Error && safeErrors.has(error.message)
              ? error.message
              : 'Card diagnostic unavailable for this tab'
          return {
            isError: true,
            content: [{ type: 'text' as const, text: message }]
          }
        }
      }
    )
  }
  register(
    'card_tabs',
    'List only supported card tabs, without page titles or query values.',
    {},
    () => backend.list()
  )
  register(
    'card_open_history',
    'Open the fixed issuer transaction-history page and start passive request observation. Does not log in or submit forms.',
    { issuer: z.enum(CARD_DIAGNOSTIC_ISSUERS) },
    ({ issuer }) => backend.openHistory(issuer as CardDiagnosticIssuer)
  )
  register(
    'card_inspect',
    'Inspect card login state and value-free history-page structure. Does not return financial rows.',
    { tabId: z.string().uuid() },
    ({ tabId }) => backend.inspect(String(tabId))
  )
  register(
    'card_requests',
    'Read sanitized request metadata and response row counts from the observed card history tab.',
    { tabId: z.string().uuid() },
    ({ tabId }) => backend.requests(String(tabId))
  )
  if (backend.queryContract)
    register(
      'card_query_contract',
      'Read sanitized static history-query functions. Never reads form values, invokes query functions, or returns account data.',
      { tabId: z.string().uuid() },
      ({ tabId }) => backend.queryContract!(String(tabId))
    )
  if (backend.login)
    register(
      'card_restore_session',
      'Restore a supported card session using the existing KeyMaster login and failed-attempt protection. Returns only fixed status codes; never returns credentials.',
      { tabId: z.string().uuid() },
      ({ tabId }) => backend.login!(String(tabId)),
      false
    )
  if (backend.collect)
    register(
      'card_collect_recent',
      'Collect all pages for today and the preceding three Korea dates with fixed issuer adapters. Optionally save to the local finance ledger. Returns only counts and completion/review status.',
      { tabId: z.string().uuid(), save: z.boolean().default(false) },
      ({ tabId, save }) => backend.collect!(String(tabId), save === true),
      false
    )
  const stop = (): void => backend.dispose()
  signal.addEventListener('abort', stop, { once: true })
  try {
    const bridge = await startCodexMcp({ server: { instance: server, tools }, signal })
    return {
      ...bridge,
      close: async () => {
        signal.removeEventListener('abort', stop)
        backend.dispose()
        await bridge.close()
      }
    }
  } catch {
    signal.removeEventListener('abort', stop)
    backend.dispose()
    throw new Error('Cannot start card diagnostics MCP')
  }
}
