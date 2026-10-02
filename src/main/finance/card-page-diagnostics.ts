import { z } from 'zod'
import type { Tab } from '../browser/tab-manager'
import { pageBridge } from '../browser/page-bridge'
import type { FinanceCardIssuer } from '../../shared/finance-capture'
import { financeCardIssuer } from './capture-schema'

export const CARD_HISTORY_URLS: Readonly<Record<FinanceCardIssuer, string>> = Object.freeze({
  hyundai_card: 'https://www.hyundaicard.com/cpa/cb/CPACB0101_01.hc',
  samsung_card: 'https://www.samsungcard.com/personal/card/activity/UHPPRP0801M0.jsp',
  lotte_card: 'https://www.lottecard.co.kr/app/LPMCDAA_V100.lc'
})

export function issuerForCardUrl(url: string): FinanceCardIssuer | null {
  return financeCardIssuer(url)
}

const POLICY = {
  hyundai_card: {
    origins: ['https://www.hyundaicard.com', 'https://hyundaicard.com'],
    paths: ['/cpa/cb/CPACB0101_01.hc'],
    assets: ['https://www.hyundaicard.com', 'https://hyundaicard.com'],
    queryPath: '^/cpa/cb/CPACB0101_[0-9]{2}\\.hc$'
  },
  samsung_card: {
    origins: ['https://www.samsungcard.com'],
    paths: [
      '/personal/card/activity/UHPPRP0801M0.jsp',
      '/personal/card/activity/UHPPRP0801D0.jsp',
      '/personal/card/activity/UHPPRP0801D8.jsp'
    ],
    assets: ['https://www.samsungcard.com', 'https://static12.samsungcard.com'],
    queryPath:
      '^/(?:frontservice/SHPPRP0801S[0-9]{2}|personal/card/activity/UHPPRP0801[MDL][A-Z0-9]\\.jsp)$'
  },
  lotte_card: {
    origins: ['https://www.lottecard.co.kr'],
    paths: ['/app/LPMCDAA_V100.lc'],
    assets: ['https://www.lottecard.co.kr', 'https://image.lottecard.co.kr'],
    queryPath: '^/app/LPMCDAA_[A-Z][0-9]{3}\\.lc$'
  }
} as const

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$-]{0,79}$/
const FUNCTION_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*){0,3}$/
function safeIdentifier(value: string): boolean {
  return IDENTIFIER.test(value) && !/\d{4,}/.test(value)
}
function safeFunctionName(value: string): boolean {
  const name = value.split('.').at(-1)!
  return (
    value.length <= 100 &&
    FUNCTION_NAME.test(value) &&
    !/\d{4,}/.test(value) &&
    /^(?:(?:fn_?)?(?:sel(?:ect)?|search|inqr|inquire|query|retrieve|load|fetch|get|find|more|next)|cardUIzInqr)/i.test(
      name
    )
  )
}
function safePath(value: string, issuer: FinanceCardIssuer): boolean {
  return new RegExp(POLICY[issuer].queryPath).test(value)
}
function safeScriptUrl(value: string, issuer: FinanceCardIssuer): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.port === '' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (POLICY[issuer].assets as readonly string[]).includes(url.origin) &&
      /^\/[A-Za-z0-9_./-]+\.js$/i.test(url.pathname) &&
      !/\d{8,}/.test(url.pathname)
    )
  } catch {
    return false
  }
}

const identifier = z.string().refine(safeIdentifier)
const functions = z.array(z.string().refine(safeFunctionName)).max(120)
const controlSchema = z
  .object({
    tag: z.enum(['input', 'select', 'textarea', 'button']),
    type: z.enum([
      'text',
      'hidden',
      'password',
      'checkbox',
      'radio',
      'date',
      'month',
      'number',
      'email',
      'tel',
      'search',
      'submit',
      'button',
      'reset',
      'file',
      'other'
    ]),
    id: identifier.optional(),
    name: identifier.optional(),
    omittedId: z.boolean(),
    omittedName: z.boolean(),
    optionCount: z.number().int().min(0).max(10000),
    visible: z.boolean(),
    handlers: z.array(z.string().refine(safeFunctionName)).max(8)
  })
  .strict()
const structureSchema = z
  .object({
    issuer: z.enum(['hyundai_card', 'samsung_card', 'lotte_card']),
    pathname: z.string().max(160),
    forms: z
      .array(
        z
          .object({
            id: identifier.optional(),
            name: identifier.optional(),
            omittedId: z.boolean(),
            omittedName: z.boolean(),
            method: z.enum(['get', 'post', 'other']),
            actionPath: z.string().max(160).optional(),
            omittedAction: z.boolean(),
            controlCount: z.number().int().min(0).max(10000)
          })
          .strict()
      )
      .max(20),
    controls: z.array(controlSchema).max(200),
    scriptUrls: z.array(z.string().max(500)).max(80),
    functionNames: functions,
    queryPaths: z.array(z.string().max(160)).max(80),
    truncated: z.boolean()
  })
  .strict()

export type CardPageStructure = z.infer<typeof structureSchema>
export interface CardPageDiagnostics {
  issuer: FinanceCardIssuer | null
  state:
    | 'ready'
    | 'signed_out'
    | 'unknown'
    | 'unsupported'
    | 'not_history_page'
    | 'navigation_changed'
    | 'invalid_result'
    | 'error'
  auth: 'signed_in' | 'signed_out' | 'unknown' | 'unsupported'
  historyUrl?: string
  structure?: CardPageStructure
}

// A fixed, read-only program. No caller-supplied code, selectors, URLs or values
// are interpolated. It neither invokes discovered functions nor sends requests.
const INSPECTION_SCRIPT = String.raw`(() => {
  const policies = ${JSON.stringify(POLICY)};
  const current = new URL(location.href);
  if (current.protocol !== 'https:' || current.port || current.username || current.password) return null;
  const issuer = Object.keys(policies).find(key => policies[key].origins.includes(current.origin));
  if (!issuer || !policies[issuer].paths.includes(current.pathname)) return null;
  const policy = policies[issuer];
  const result = { issuer, pathname: current.pathname, forms: [], controls: [], scriptUrls: [], functionNames: [], queryPaths: [], truncated: false };
  const identifier = value => /^[A-Za-z_$][A-Za-z0-9_$-]{0,79}$/.test(value) && !/\d{4,}/.test(value);
  const functionName = value => {
    const name = value.split('.').pop();
    return value.length <= 100 && /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*){0,3}$/.test(value) && !/\d{4,}/.test(value) && /^(?:(?:fn_?)?(?:sel(?:ect)?|search|inqr|inquire|query|retrieve|load|fetch|get|find|more|next)|cardUIzInqr)/i.test(name);
  };
  const identity = element => {
    const id = element.getAttribute('id') || '';
    const name = element.getAttribute('name') || '';
    return { ...(id && identifier(id) ? { id } : {}), ...(name && identifier(name) ? { name } : {}), omittedId: !!id && !identifier(id), omittedName: !!name && !identifier(name) };
  };
  const visible = element => {
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };
  const path = value => {
    try {
      const url = new URL(value, current.href);
      if (url.protocol !== 'https:' || url.port || url.username || url.password || !policy.origins.includes(url.origin)) return null;
      return new RegExp(policy.queryPath).test(url.pathname) ? url.pathname : null;
    } catch { return null; }
  };
  const unique = (array, value, limit) => {
    if (!value || array.includes(value)) return;
    if (array.length < limit) array.push(value); else result.truncated = true;
  };
  const forms = Array.from(document.querySelectorAll('form'));
  if (forms.length > 20) result.truncated = true;
  for (const form of forms.slice(0, 20)) {
    const action = form.getAttribute('action') || '';
    const actionPath = action ? path(action) : null;
    const method = (form.getAttribute('method') || 'get').toLowerCase();
    result.forms.push({ ...identity(form), method: ['get', 'post'].includes(method) ? method : 'other', ...(actionPath ? { actionPath } : {}), omittedAction: !!action && !actionPath, controlCount: Math.min(form.querySelectorAll('input,select,textarea,button').length, 10000) });
  }
  const controls = Array.from(document.querySelectorAll('input,select,textarea,button'));
  if (controls.length > 200) result.truncated = true;
  const types = ['text','hidden','password','checkbox','radio','date','month','number','email','tel','search','submit','button','reset','file'];
  for (const control of controls.slice(0, 200)) {
    const tag = control.tagName.toLowerCase();
    const type = (control.getAttribute('type') || (tag === 'input' ? 'text' : tag === 'button' ? 'submit' : 'other')).toLowerCase();
    const handlers = [];
    for (const attribute of ['onclick','onchange']) {
      const source = control.getAttribute(attribute) || '';
      if (source.length > 4000) { result.truncated = true; continue; }
      for (const match of source.matchAll(/(?:^|[;{}])\s*(?:return\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,3})\s*\(/g)) {
        if (functionName(match[1])) unique(handlers, match[1], 8);
      }
    }
    result.controls.push({ ...identity(control), tag, type: types.includes(type) ? type : 'other', optionCount: tag === 'select' ? Math.min(control.querySelectorAll('option').length, 10000) : 0, visible: visible(control), handlers });
  }
  let scanned = 0;
  const scripts = Array.from(document.querySelectorAll('script'));
  if (scripts.length > 200) result.truncated = true;
  for (const script of scripts.slice(0, 200)) {
    const src = script.getAttribute('src');
    if (src) {
      try {
        const url = new URL(src, current.href);
        if (url.protocol === 'https:' && !url.port && !url.username && !url.password && policy.assets.includes(url.origin) && /^\/[A-Za-z0-9_./-]+\.js$/i.test(url.pathname) && !/\d{8,}/.test(url.pathname)) unique(result.scriptUrls, url.origin + url.pathname, 80);
      } catch {}
      continue;
    }
    const kind = (script.getAttribute('type') || '').toLowerCase();
    if (kind && !['text/javascript','application/javascript','module'].includes(kind)) continue;
    const source = script.textContent || '';
    scanned += source.length;
    if (source.length > 200000 || scanned > 500000) { result.truncated = true; continue; }
    for (const pattern of [
      /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g,
      /(?:^|[,;{\n])\s*([A-Za-z_$][\w$]*)\s*:\s*function\s*\(/g,
      /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,3})\s*=\s*function\s*\(/g
    ]) {
      for (const match of source.matchAll(pattern)) if (functionName(match[1])) unique(result.functionNames, match[1], 120);
    }
    for (const match of source.matchAll(/["']((?:https:\/\/|\/)[A-Za-z0-9_./:?=&%-]{1,500})["']/g)) unique(result.queryPaths, path(match[1]), 80);
  }
  return result;
})()`

async function readAuth(tab: Tab, issuer: FinanceCardIssuer): Promise<CardPageDiagnostics['auth']> {
  if (issuer === 'hyundai_card') {
    const snapshot = await pageBridge.hyundaiAuth(tab)
    if (snapshot.state === 'signed_in') return 'signed_in'
    if (
      ['pin_ready', 'registration_required', 'additional_auth', 'pin_error'].includes(
        snapshot.state
      )
    )
      return 'signed_out'
    return snapshot.state === 'unsupported' ? 'unsupported' : 'unknown'
  }
  const snapshot = await pageBridge.cardSession(tab)
  return snapshot.issuer === issuer ? snapshot.state : 'unknown'
}

export async function inspectCardPage(tab: Tab): Promise<CardPageDiagnostics> {
  let issuer: FinanceCardIssuer | null = null
  let auth: CardPageDiagnostics['auth'] = 'unknown'
  const result = (state: CardPageDiagnostics['state']): CardPageDiagnostics => ({
    issuer,
    state,
    auth,
    ...(issuer ? { historyUrl: CARD_HISTORY_URLS[issuer] } : {})
  })
  try {
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return result('error')
    const initialUrl = wc.getURL()
    issuer = issuerForCardUrl(initialUrl)
    if (!issuer) {
      auth = 'unsupported'
      return result('unsupported')
    }
    auth = await readAuth(tab, issuer)
    if (wc.isDestroyed() || wc.getURL() !== initialUrl) return result('navigation_changed')
    if (auth !== 'signed_in') return result(auth === 'signed_out' ? 'signed_out' : 'unknown')
    const initialPath = new URL(initialUrl).pathname
    if (!(POLICY[issuer].paths as readonly string[]).includes(initialPath))
      return result('not_history_page')
    const raw = await wc.executeJavaScript(INSPECTION_SCRIPT, false)
    if (wc.isDestroyed() || wc.getURL() !== initialUrl) return result('navigation_changed')
    const parsed = structureSchema.safeParse(raw)
    if (!parsed.success) return result('invalid_result')
    const structure = parsed.data
    if (
      structure.issuer !== issuer ||
      structure.pathname !== initialPath ||
      structure.forms.some((form) => form.actionPath && !safePath(form.actionPath, issuer!)) ||
      structure.queryPaths.some((path) => !safePath(path, issuer!)) ||
      structure.scriptUrls.some((url) => !safeScriptUrl(url, issuer!))
    )
      return result('invalid_result')
    auth = await readAuth(tab, issuer)
    if (wc.isDestroyed() || wc.getURL() !== initialUrl) return result('navigation_changed')
    if (auth !== 'signed_in') return result(auth === 'signed_out' ? 'signed_out' : 'unknown')
    return { ...result('ready'), structure }
  } catch {
    return result('error')
  }
}
