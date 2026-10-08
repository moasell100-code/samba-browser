import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { startCodexMcp, type CodexMcpBridge } from '../agent/codex-mcp'
import { dailyCardRanges, recentCardDateRange } from './card-date-range'

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
  exportContract?(tabId: string): Promise<unknown>
  exportHistory?(tabId: string, from: string, to: string, scope?: string): Promise<unknown>
  login?(tabId: string): Promise<unknown>
  collect?(tabId: string, save: boolean): Promise<unknown>
  collectRange?(tabId: string, from: string, to: string): Promise<unknown>
  cancellationContract?(tabId: string, from: string, to: string): Promise<unknown>
  cancellationRange?(tabId: string, from: string, to: string): Promise<unknown>
  hyundaiCancellationEvidence?(tabId: string, from: string, to: string): Promise<unknown>
  cancelDateProbe?(tabId: string, from: string, to: string): Promise<unknown>
  reconcile?(tabId: string): Promise<unknown>
  recoverRegistration?(tabId: string): Promise<unknown>
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
  if (backend.exportContract)
    register(
      'card_export_contract',
      'Inspect value-free Excel export controls and static function metadata on the signed-in issuer history page. Does not export, submit forms or return financial rows.',
      { tabId: z.string().uuid() },
      ({ tabId }) => backend.exportContract!(String(tabId))
    )
  if (backend.exportHistory)
    register(
      'card_export_history',
      'Download the signed-in card issuer original Excel for one calendar month or shorter. Saves locally and returns only file receipt and counts. No ledger write. Samsung scope defaults to domestic.',
      {
        tabId: z.string().uuid(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        scope: z
          .enum([
            'domestic',
            'domestic_cancellation',
            'overseas',
            'overseas_cancellation',
            'transport',
            'transport_tmoney',
            'hipass',
            'acquired'
          ])
          .optional()
      },
      ({ tabId, from, to, scope }) =>
        backend.exportHistory!(
          String(tabId),
          String(from),
          String(to),
          scope as string | undefined
        ),
      false
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
  if (backend.collectRange)
    register(
      'card_collect_range_preview',
      'Read a bounded historical range of at most four days. Returns only receipt, counts and date-basis diagnostics; never saves or returns transactions.',
      {
        tabId: z.string().uuid(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
      },
      ({ tabId, from, to }) => backend.collectRange!(String(tabId), String(from), String(to))
    )
  if (backend.cancellationContract)
    register(
      'card_cancellation_contract',
      'Inspect fixed issuer cancellation services for at most four dates. Returns only schema and proof counts; no transaction values, request replay, or ledger writes.',
      {
        tabId: z.string().uuid(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
      },
      ({ tabId, from, to }) =>
        backend.cancellationContract!(String(tabId), String(from), String(to))
    )
  if (backend.cancelDateProbe)
    register(
      'card_cancel_date_probe',
      'Read-only fixed Samsung S43 and Lotte all/cancellation queries for at most four Korea calendar dates since July 1. Lotte requires unique public status-option mapping. Returns only date-range counts, state-code counts and page termination. No financial rows, amounts, identifiers, cancellation proof or writes. Other issuers are unsupported.',
      {
        tabId: z.string().uuid(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
      },
      ({ tabId, from, to }) => {
        const range = { from: String(from), to: String(to) }
        try {
          dailyCardRanges(range)
          if (range.from < '2026-07-01' || range.to > recentCardDateRange().to) throw new Error()
        } catch {
          return { state: 'invalid_range' }
        }
        return backend.cancelDateProbe!(String(tabId), range.from, range.to)
      }
    )
  for (const [name, callback] of [
    ['card_collect_cancellations_preview', backend.cancellationRange],
    ['hyundai_cancellation_evidence', backend.hyundaiCancellationEvidence]
  ] as const) {
    if (callback)
      register(
        name,
        'Read a fixed cancellation query for at most four dates since July 1; returns only verification counts. No financial rows, identifiers, credentials or ledger writes.',
        {
          tabId: z.string().uuid(),
          from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
        },
        ({ tabId, from, to }) => {
          const range = { from: String(from), to: String(to) }
          try {
            dailyCardRanges(range)
            if (range.from < '2026-07-01' || range.to > recentCardDateRange().to) throw new Error()
          } catch {
            return { state: 'invalid_range' }
          }
          return callback(String(tabId), range.from, range.to)
        }
      )
  }
  if (backend.reconcile)
    register(
      'card_reconcile_existing',
      'Query cancellations in the backend-leased rolling three-month window using bounded issuer adapters and save verified changes to existing originals. Preserves classifications and returns only counts and completion codes.',
      { tabId: z.string().uuid() },
      ({ tabId }) => backend.reconcile!(String(tabId)),
      false
    )
  const stop = (): void => backend.dispose()
  if (backend.recoverRegistration)
    register(
      'hyundai_restore_registration',
      'Recover only unexpired Hyundai registration cookies from the one retained local backup into the same default workspace, only when registration is missing. No PIN change, vault edit, arbitrary path or credential output. One attempt per session.',
      { tabId: z.string().uuid() },
      ({ tabId }) => backend.recoverRegistration!(String(tabId)),
      false
    )
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
