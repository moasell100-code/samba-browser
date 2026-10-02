import type { WebContents } from 'electron'
import { createHash } from 'node:crypto'
import type { FinanceCardIssuer } from '../../shared/finance-capture'
import { ensureDebuggerAttached } from '../browser/emulation'
import { summarizeLotteHistoryContent } from './lotte-response-summary'

export const CARD_NETWORK_LIMITS = {
  durationMs: 120_000,
  requests: 50,
  pendingBodies: 4,
  bodyBytes: 2 * 1024 * 1024,
  requestBytes: 16 * 1024,
  bodyTimeoutMs: 3_000,
  shapeNodes: 200,
  shapeDepth: 5,
  shapeArrays: 20,
  shapeTotals: 20,
  fieldDepth: 3,
  fields: 50
} as const

export interface CardResponseShape {
  kind: 'json' | 'non_json' | 'empty' | 'too_large' | 'unavailable'
  arrays: Array<{ path: string; count: number; fields?: string[] }>
  totals: Array<{ path: string; count: number }>
  truncated: boolean
  lotteHtml?: ReturnType<typeof summarizeLotteHistoryContent>
}
export interface CardNetworkRecord {
  origin: string
  path: string
  pathRedacted: boolean
  method: 'GET' | 'POST'
  queryFields: string[]
  bodyFields: string[]
  fieldsTruncated: boolean
  status?: number
  response?: CardResponseShape
}
export interface CardNetworkSnapshot {
  state: 'idle' | 'watching' | 'stopped' | 'unavailable'
  issuer: FinanceCardIssuer
  records: CardNetworkRecord[]
  limitReached: boolean
}

const HOSTS: Record<FinanceCardIssuer, readonly string[]> = {
  hyundai_card: ['www.hyundaicard.com', 'hyundaicard.com'],
  samsung_card: ['www.samsungcard.com'],
  lotte_card: ['www.lottecard.co.kr']
}
const HISTORY: Record<FinanceCardIssuer, readonly string[]> = {
  hyundai_card: ['/cpa/cb/CPACB0101_01.hc'],
  samsung_card: [
    '/personal/card/activity/UHPPRP0801M0.jsp',
    '/personal/card/activity/UHPPRP0801D0.jsp',
    '/personal/card/activity/UHPPRP0801D8.jsp',
    '/personal/card/activity/UHPPRP0801DF.jsp'
  ],
  lotte_card: ['/app/LPMCDAA_V100.lc']
}
// These families are login/security and known payment actions, even if their route names
// are opaque codes. Observation is passive, but none of their bodies belong in this tool.
const SENSITIVE_PATH =
  /(?:login|logout|sign[-_]?in|auth|oauth|token|session|password|passwd|credential|certificate|pinsign|delfino|nppfs|register|enroll|delete|remove|update|insert|save|submit|payment|repay|transfer|withdraw|remit|loan|cashservice|account|profile|cpm\/mb|LPMCDCB|LPMANAA|UHPPCO)/i
const SENSITIVE_KEY =
  /(?:password|passwd|secret|token|cookie|authorization|credential|session|csrf|ssn|resident|pin(?:code)?$|otp$)/i
const STATIC_SEGMENTS = new Set([
  'api',
  'app',
  'cpa',
  'cb',
  'personal',
  'card',
  'activity',
  'history',
  'usage',
  'use',
  'transaction',
  'transactions',
  'inquiry',
  'search',
  'select',
  'list',
  'approval',
  'cancel',
  'cancellation',
  'detail',
  'details',
  'service',
  'frontservice',
  'rest',
  'json',
  'data',
  'result',
  'get',
  'retrieve',
  'v1',
  'v2',
  'v3',
  'common',
  'ajax',
  'hp',
  'im',
  'my',
  'carduse'
])
const TOTAL_FIELDS = new Set([
  'totalcount',
  'totalcnt',
  'totcnt',
  'totalrecordcount',
  'totalrecords',
  'recordcount',
  'recordcnt',
  'rowcount',
  'totrowcnt',
  'totalrowcount',
  'totalrows',
  'listcount',
  'totlistcnt',
  'totdlngct'
])
type Pending = {
  record: CardNetworkRecord
  target: string
  bodyEligible: boolean
  responseUrlVerified: boolean
}

function targetKey(url: URL): string {
  return createHash('sha256')
    .update(url.origin + url.pathname)
    .digest('hex')
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function allowedUrl(value: unknown, issuer: FinanceCardIssuer): URL | null {
  if (typeof value !== 'string' || value.length > 8192) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' &&
      !url.port &&
      !url.username &&
      !url.password &&
      HOSTS[issuer]?.includes(url.hostname)
      ? url
      : null
  } catch {
    return null
  }
}
function historyUrl(value: unknown, issuer: FinanceCardIssuer): boolean {
  const url = allowedUrl(value, issuer)
  return !!url && HISTORY[issuer].includes(url.pathname)
}
function fieldName(value: string): string | null {
  return /^[A-Za-z_$][A-Za-z0-9_$.-]{0,63}$/.test(value) &&
    !/\d{5}/.test(value) &&
    !SENSITIVE_KEY.test(value) &&
    !/private/i.test(value)
    ? value
    : null
}
function safePath(pathname: string): { path: string; pathRedacted: boolean } {
  let pathRedacted = false
  const segments = pathname.split('/')
  if (segments.length > 25) pathRedacted = true
  const path = segments
    .slice(0, 25)
    .map((segment) => {
      if (!segment) return ''
      // Published card screen/function filenames are stable routes, unlike numeric record IDs.
      const cardCode =
        !segment.startsWith('CPACB0101_') &&
        /^(?:[A-Z]{3,10}\d{4}(?:_[A-Z0-9]{2,8}|[A-Z0-9]{2,4})|LPMCDAA_[A-Z]\d{3})\.(?:hc|lc|jsp|do)$/.test(
          segment
        )
      const namedRead =
        /^(?:get|select|search|retrieve|inquire|query|list)[A-Za-z_-]{0,48}\.(?:do|json|ajax|jsp|hc|lc)$/i.test(
          segment
        )
      const samsungHistoryService = /^SHPPRP0801S\d{2}$/.test(segment)
      // The fixed history screen family uses short lowercase operation names. Longer numeric
      // suffixes may be dynamic identifiers; never let the general card-code rule admit them.
      const hyundaiSuffix = /^CPACB0101_([a-z0-9_]{1,24})\.(?:hc|json|ajax|do)$/.exec(segment)?.[1]
      const hyundaiHistoryService = !!hyundaiSuffix && !/\d{4}/.test(hyundaiSuffix)
      if (
        cardCode ||
        namedRead ||
        samsungHistoryService ||
        hyundaiHistoryService ||
        STATIC_SEGMENTS.has(segment.toLowerCase())
      )
        return segment
      pathRedacted = true
      return '[redacted]'
    })
    .join('/')
  return { path, pathRedacted }
}
function safeFields(names: Iterable<string>): { fields: string[]; truncated: boolean } {
  const fields = new Set<string>()
  let scanned = 0
  let truncated = false
  for (const name of names) {
    if (++scanned > CARD_NETWORK_LIMITS.fields) {
      truncated = true
      break
    }
    const safe = fieldName(name)
    if (safe) fields.add(safe)
  }
  return { fields: [...fields].sort(), truncated }
}
function requestFields(request: Record<string, unknown>): { fields: string[]; truncated: boolean } {
  if (typeof request.postData !== 'string')
    return { fields: [], truncated: request.hasPostData === true }
  if (Buffer.byteLength(request.postData) > CARD_NETWORK_LIMITS.requestBytes)
    return { fields: [], truncated: true }
  try {
    const trimmed = request.postData.trim()
    if (trimmed.startsWith('{')) {
      const parsed: unknown = JSON.parse(trimmed)
      if (!plain(parsed)) return { fields: [], truncated: true }
      const fields: string[] = []
      let scanned = 0
      let truncated = false
      const walk = (object: Record<string, unknown>, parent: string, depth: number): void => {
        for (const key of Object.keys(object)) {
          if (++scanned > CARD_NETWORK_LIMITS.fields) {
            truncated = true
            break
          }
          const safe = fieldName(key)
          if (!safe) continue
          const path = parent ? `${parent}.${safe}` : safe
          fields.push(path)
          // Objects describe parameter namespaces. Array elements are never inspected.
          if (plain(object[key])) {
            if (depth >= CARD_NETWORK_LIMITS.fieldDepth) truncated = true
            else walk(object[key] as Record<string, unknown>, path, depth + 1)
          }
        }
      }
      walk(parsed, '', 1)
      return { fields: [...new Set(fields)].sort(), truncated }
    }
    if (trimmed.includes('=') && !trimmed.includes('\r') && !trimmed.includes('\n'))
      return safeFields(new URLSearchParams(trimmed).keys())
  } catch {
    /* fixed metadata only */
  }
  return { fields: [], truncated: request.hasPostData === true || request.postData.length > 0 }
}
function emptyShape(kind: CardResponseShape['kind']): CardResponseShape {
  return { kind, arrays: [], totals: [], truncated: false }
}
function responseShape(body: string, includeLotteHtml = false): CardResponseShape {
  if (Buffer.byteLength(body) > CARD_NETWORK_LIMITS.bodyBytes) return emptyShape('too_large')
  if (!body.trim()) return emptyShape('empty')
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return emptyShape('non_json')
  }
  const summary = emptyShape('json')
  if (includeLotteHtml) summary.lotteHtml = summarizeLotteHistoryContent(parsed)
  let visited = 0
  const walk = (value: unknown, path: string, depth: number): void => {
    if (++visited > CARD_NETWORK_LIMITS.shapeNodes || depth > CARD_NETWORK_LIMITS.shapeDepth) {
      summary.truncated = true
      return
    }
    if (Array.isArray(value)) {
      if (summary.arrays.length >= CARD_NETWORK_LIMITS.shapeArrays) summary.truncated = true
      else
        summary.arrays.push({
          path,
          count: value.length,
          ...(plain(value[0]) && safeFields(Object.keys(value[0])).fields.length
            ? { fields: safeFields(Object.keys(value[0])).fields }
            : {})
        })
      return // Only schema field names; never return row values or traverse nested row data.
    }
    if (!plain(value)) return
    const keys = Object.keys(value)
    if (keys.length > CARD_NETWORK_LIMITS.fields) summary.truncated = true
    for (const key of keys.slice(0, CARD_NETWORK_LIMITS.fields)) {
      if (visited >= CARD_NETWORK_LIMITS.shapeNodes) {
        summary.truncated = true
        break
      }
      const safe = fieldName(key)
      if (!safe) continue
      const childPath = `${path}.${safe}`
      const child = value[key]
      if (TOTAL_FIELDS.has(safe.replace(/[_.-]/g, '').toLowerCase())) {
        const count =
          typeof child === 'number'
            ? child
            : typeof child === 'string' && /^\d{1,8}$/.test(child)
              ? Number(child)
              : NaN
        if (Number.isSafeInteger(count) && count >= 0 && count <= 10_000_000) {
          if (summary.totals.length >= CARD_NETWORK_LIMITS.shapeTotals) summary.truncated = true
          else summary.totals.push({ path: childPath, count })
        }
      }
      if (Array.isArray(child) || plain(child)) walk(child, childPath, depth + 1)
    }
  }
  walk(parsed, '$', 0)
  return summary
}

/** Passive, short-lived CDP observation. No login, request replay, cookies, headers or disk. */
export class CardNetworkObserver {
  private state: CardNetworkSnapshot['state'] = 'idle'
  private records: CardNetworkRecord[] = []
  private pending = new Map<string, Pending>()
  private timer?: ReturnType<typeof setTimeout>
  private startPromise?: Promise<void>
  private limitReached = false
  private activeBodies = 0
  private generation = 0
  private listeners = false

  constructor(
    private readonly wc: WebContents,
    private readonly issuer: FinanceCardIssuer
  ) {}

  start(): Promise<void> {
    return (this.startPromise ??= this.attach())
  }

  private async attach(): Promise<void> {
    if (this.state !== 'idle') return
    if (!HOSTS[this.issuer] || !ensureDebuggerAttached(this.wc)) {
      this.state = 'unavailable'
      return
    }
    this.state = 'watching'
    this.wc.debugger.on('message', this.onMessage)
    this.wc.debugger.on('detach', this.onDetach)
    this.wc.once('destroyed', this.onDestroyed)
    this.listeners = true
    this.timer = setTimeout(() => this.dispose(), CARD_NETWORK_LIMITS.durationMs)
    this.timer.unref?.()
    let commandTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.wc.debugger.sendCommand('Network.enable', {
          maxTotalBufferSize: CARD_NETWORK_LIMITS.bodyBytes * 4,
          maxResourceBufferSize: CARD_NETWORK_LIMITS.bodyBytes,
          maxPostDataSize: CARD_NETWORK_LIMITS.requestBytes
        }),
        new Promise<never>((_, reject) => {
          commandTimer = setTimeout(
            () => reject(new Error('unavailable')),
            CARD_NETWORK_LIMITS.bodyTimeoutMs
          )
          commandTimer.unref?.()
        })
      ])
    } catch {
      this.dispose()
      this.state = 'unavailable'
    } finally {
      if (commandTimer) clearTimeout(commandTimer)
    }
  }

  snapshot(): CardNetworkSnapshot {
    return structuredClone({
      state: this.state,
      issuer: this.issuer,
      records: this.records,
      limitReached: this.limitReached
    })
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.generation++
    this.pending.clear()
    if (this.listeners) {
      this.wc.debugger.removeListener('message', this.onMessage)
      this.wc.debugger.removeListener('detach', this.onDetach)
      this.wc.removeListener('destroyed', this.onDestroyed)
      this.listeners = false
    }
    if (this.state !== 'unavailable') this.state = 'stopped'
    // The debugger and Network domain may be shared by dialogs/emulation/another observer.
    // Never detach it, disable Network, or remove another owner's listeners.
  }

  private readonly onDestroyed = (): void => this.dispose()
  private readonly onDetach = (): void => {
    this.dispose()
    this.state = 'unavailable'
  }

  private readonly onMessage = (
    _event: unknown,
    method: string,
    params: unknown,
    sessionId?: string
  ): void => {
    if (sessionId || this.state !== 'watching' || !plain(params)) return
    try {
      if (this.wc.isDestroyed() || !historyUrl(this.wc.getURL(), this.issuer)) return
      const requestId =
        typeof params.requestId === 'string' && params.requestId.length <= 128
          ? params.requestId
          : null
      if (!requestId) return
      if (method === 'Network.requestWillBeSent') this.request(requestId, params)
      else if (method === 'Network.responseReceived') this.response(requestId, params)
      else if (method === 'Network.loadingFinished') void this.finished(requestId, params)
      else if (method === 'Network.loadingFailed') {
        const pending = this.pending.get(requestId)
        if (pending) pending.record.response = emptyShape('unavailable')
        this.pending.delete(requestId)
      }
    } catch {
      /* Never log CDP payloads or exception messages. */
    }
  }

  private request(requestId: string, params: Record<string, unknown>): void {
    this.pending.delete(requestId) // A redirect cannot inherit an earlier eligible request.
    if (
      !['XHR', 'Fetch'].includes(String(params.type)) ||
      !historyUrl(params.documentURL, this.issuer) ||
      !plain(params.request)
    )
      return
    const request = params.request
    const url = allowedUrl(request.url, this.issuer)
    if (
      !url ||
      SENSITIVE_PATH.test(decodeURIComponent(url.pathname)) ||
      !['GET', 'POST'].includes(String(request.method))
    )
      return
    if (this.records.length >= CARD_NETWORK_LIMITS.requests) {
      this.limitReached = true
      return
    }
    const query = safeFields(url.searchParams.keys())
    const body = requestFields(request)
    const record: CardNetworkRecord = {
      origin: url.origin,
      ...safePath(url.pathname),
      method: request.method as 'GET' | 'POST',
      queryFields: query.fields,
      bodyFields: body.fields,
      fieldsTruncated: query.truncated || body.truncated
    }
    this.records.push(record)
    this.pending.set(requestId, {
      record,
      target: targetKey(url),
      bodyEligible: false,
      responseUrlVerified: false
    })
  }

  private response(requestId: string, params: Record<string, unknown>): void {
    const pending = this.pending.get(requestId)
    if (!pending || !plain(params.response)) return
    const response = params.response
    const url = allowedUrl(response.url, this.issuer)
    if (!url || SENSITIVE_PATH.test(decodeURIComponent(url.pathname))) {
      this.pending.delete(requestId)
      return
    }
    if (targetKey(url) !== pending.target) {
      this.pending.delete(requestId)
      return
    }
    if (
      typeof response.status === 'number' &&
      Number.isInteger(response.status) &&
      response.status >= 100 &&
      response.status <= 599
    )
      pending.record.status = response.status
    const mime = typeof response.mimeType === 'string' ? response.mimeType : ''
    const jsonMime = /^(?:application|text)\/(?:[\w.+-]+\+)?json(?:;|$)/i.test(mime)
    // This observed read-only history endpoint may label its JSON as HTML/plain text.
    // It is still parsed as JSON only; actual HTML is never summarized or returned.
    const lotteHistoryText =
      this.issuer === 'lotte_card' &&
      url.origin === 'https://www.lottecard.co.kr' &&
      url.pathname === '/app/LPMCDAA_A102.lc' &&
      /^text\/(?:html|plain)(?:;|$)/i.test(mime)
    pending.bodyEligible = jsonMime || lotteHistoryText
    pending.responseUrlVerified = true
  }

  private async finished(requestId: string, params: Record<string, unknown>): Promise<void> {
    const pending = this.pending.get(requestId)
    this.pending.delete(requestId)
    if (!pending || !pending.responseUrlVerified) return
    if (!pending.bodyEligible) {
      pending.record.response = emptyShape('non_json')
      return
    }
    if ((pending.record.status ?? 0) < 200 || (pending.record.status ?? 0) >= 300) {
      pending.record.response = emptyShape('unavailable')
      return
    }
    if (
      typeof params.encodedDataLength !== 'number' ||
      !Number.isFinite(params.encodedDataLength) ||
      params.encodedDataLength < 0 ||
      params.encodedDataLength > CARD_NETWORK_LIMITS.bodyBytes
    ) {
      pending.record.response = emptyShape('too_large')
      return
    }
    if (this.activeBodies >= CARD_NETWORK_LIMITS.pendingBodies) {
      pending.record.response = emptyShape('unavailable')
      this.limitReached = true
      return
    }
    const generation = this.generation
    this.activeBodies++
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result: unknown = await Promise.race([
        this.wc.debugger.sendCommand('Network.getResponseBody', { requestId }),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), CARD_NETWORK_LIMITS.bodyTimeoutMs)
          timer.unref?.()
        })
      ])
      if (
        this.generation !== generation ||
        this.state !== 'watching' ||
        !historyUrl(this.wc.getURL(), this.issuer)
      )
        return
      if (!plain(result) || typeof result.body !== 'string')
        pending.record.response = emptyShape('unavailable')
      else if (
        result.body.length >
        CARD_NETWORK_LIMITS.bodyBytes * (result.base64Encoded === true ? 4 / 3 : 1) + 4
      )
        pending.record.response = emptyShape('too_large')
      else {
        const body =
          result.base64Encoded === true
            ? Buffer.from(result.body, 'base64').toString('utf8')
            : result.body
        pending.record.response = responseShape(
          body,
          this.issuer === 'lotte_card' && pending.record.path === '/app/LPMCDAA_A102.lc'
        )
      }
    } catch {
      if (this.generation === generation) pending.record.response = emptyShape('unavailable')
    } finally {
      if (timer) clearTimeout(timer)
      this.activeBodies--
    }
  }
}
