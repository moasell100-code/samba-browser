import { z } from 'zod'
import type { Tab } from '../browser/tab-manager'
import { inspectCardPage } from './card-page-diagnostics'

const identifier = z
  .string()
  .regex(/^[A-Za-z_$][A-Za-z0-9_$-]{0,79}$/)
  .refine((v) => !/\d{4,}/.test(v))
const functionName = z
  .string()
  .regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,3}$/)
  .max(160)
const path = z
  .string()
  .regex(
    /^\/(?:cpa\/cb\/(?:api)?CPACB0101_(?:[0-9]{2}|105)\.hc|app\/LPMCDAA_[A-Z][0-9]{3}\.lc|personal\/card\/activity\/UHPPRP0801[A-Z0-9]{2}\.jsp|frontservice\/SHPPRP0801S[0-9]{2})$/
  )
const exportSchema = z
  .object({
    controls: z
      .array(
        z
          .object({
            tag: z.enum(['a', 'button', 'input']),
            id: identifier.optional(),
            name: identifier.optional(),
            label: z.enum(['excel', 'download', 'unrecognized']),
            handlers: z.array(functionName).max(8)
          })
          .strict()
      )
      .max(40),
    functions: z
      .array(
        z
          .object({
            name: functionName,
            calls: z.array(functionName).max(60),
            paths: z.array(path).max(20),
            selectors: z
              .array(
                z
                  .string()
                  .regex(/^[#.]?[A-Za-z_$][A-Za-z0-9_$-]{0,79}$/)
                  .refine((v) => !/\d{4,}/.test(v))
              )
              .max(60),
            services: z.array(z.string().regex(/^SHPPRP0801S[0-9]{2}$/)).max(10)
          })
          .strict()
      )
      .max(40),
    paths: z.array(path).max(40),
    inputNames: z.array(identifier).max(120),
    truncated: z.boolean()
  })
  .strict()

/** Fixed, read-only inspection. No page function, handler, request or form is invoked. */
const SCRIPT = String.raw`(() => {
  const url = new URL(location.href);
  const allowed = !url.username && !url.password && (
    ['https://www.hyundaicard.com','https://hyundaicard.com'].includes(url.origin) && url.pathname === '/cpa/cb/CPACB0101_01.hc' ||
    url.origin === 'https://www.lottecard.co.kr' && url.pathname === '/app/LPMCDAA_V100.lc' ||
    url.origin === 'https://www.samsungcard.com' && ['/personal/card/activity/UHPPRP0801M0.jsp','/personal/card/activity/UHPPRP0801D0.jsp','/personal/card/activity/UHPPRP0801D8.jsp'].includes(url.pathname)
  );
  if (!allowed) return null;
  const id = value => typeof value === 'string' && /^[A-Za-z_$][A-Za-z0-9_$-]{0,79}$/.test(value) && !/\d{4,}/.test(value);
  const fn = value => typeof value === 'string' && value.length <= 160 && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,3}$/.test(value) && !/\d{4,}/.test(value);
  const isExport = value => /excel|download|export|xls/i.test(value) && !/login|password|credential|vault|payment/i.test(value);
  const isPath = value => /^\/(?:cpa\/cb\/(?:api)?CPACB0101_(?:[0-9]{2}|105)\.hc|app\/LPMCDAA_[A-Z][0-9]{3}\.lc|personal\/card\/activity\/UHPPRP0801[A-Z0-9]{2}\.jsp|frontservice\/SHPPRP0801S[0-9]{2})$/.test(value);
  const sameIssuerPath = value => isPath(value) && (url.hostname.includes('hyundaicard') ? value.startsWith('/cpa/cb/') : url.hostname.includes('lottecard') ? value.startsWith('/app/') : /^\/(?:personal\/card\/activity|frontservice)\//.test(value));
  const output = { controls: [], functions: [], paths: [], inputNames: [], truncated: false };
  const targets = new Set();
  const parents = new Set();
  const addTarget = name => { if (fn(name) && isExport(name)) { targets.add(name); const parts = name.split('.'); if(parts.length > 1) parents.add(parts.slice(0,-1).join('.')); } };
  const addPath = value => { if (sameIssuerPath(value) && !output.paths.includes(value) && output.paths.length < 40) output.paths.push(value); };
  const staticWithoutComments = source => source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\.|[^\x60\\])*\x60/g, token => token.startsWith('//') || token.startsWith('/*') ? ' ' : token);
  const stripLiterals = source => source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\.|[^\x60\\])*\x60/g, ' ');
  const discover = source => {
    const code = stripLiterals(staticWithoutComments(source));
    for (const match of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) addTarget(match[1]);
    for (const match of code.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,3})\s*(?:=\s*function|\()/g)) {
      addTarget(match[1]);
      const parts = match[1].split('.');
      if (parts.length > 1 && fn(parts.slice(0,-1).join('.'))) parents.add(parts.slice(0,-1).join('.'));
    }
  };
  const sources = Array.from(document.scripts).filter(script => !script.src && (!script.type || /^(?:text|application)\/(?:java|ecma)script$/i.test(script.type))).slice(0,80);
  let sourceBudget = 400000;
  for (const script of sources) {
    const source = script.textContent || '';
    if(source.length > 250000 || source.length > sourceBudget) { output.truncated = true; continue; }
    sourceBudget -= source.length;
    discover(source);
  }
  const controls = Array.from(document.querySelectorAll('a,button,input')).slice(0,1000);
  for (const control of controls) {
    const handlers = [];
    const eventSource = control.getAttribute('onclick') || '';
    if(eventSource.length < 5000) {
      const code = stripLiterals(staticWithoutComments(eventSource));
      for (const match of code.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,3})\s*\(/g)) {
        if(fn(match[1]) && isExport(match[1]) && !handlers.includes(match[1]) && handlers.length < 8) { handlers.push(match[1]); addTarget(match[1]); }
      }
    }
    const label = (control.tagName === 'INPUT' ? '' : control.textContent || '').replace(/\s+/g,'').toLowerCase();
    const publicLabel = /^(?:엑셀(?:다운로드|저장|받기)?|excel(?:download|save)?|xls|xlsx)$/.test(label) ? 'excel' : /^(?:다운로드|download)$/.test(label) ? 'download' : 'unrecognized';
    if (!handlers.length && !isExport(control.id || '') && !isExport(control.name || '') && publicLabel === 'unrecognized') continue;
    if (output.controls.length >= 40) { output.truncated = true; break; }
    output.controls.push({tag:control.tagName.toLowerCase(),...(id(control.id) ? {id:control.id} : {}),...(id(control.name) ? {name:control.name} : {}),label:publicLabel,handlers});
  }
  for (const input of Array.from(document.querySelectorAll('input,select,textarea')).slice(0,1000)) {
    if(id(input.name) && !output.inputNames.includes(input.name)) {
      if(output.inputNames.length >= 120) { output.truncated = true; break; }
      output.inputNames.push(input.name);
    }
  }
  const ownValue = name => {
    let value = window;
    for (const part of name.split('.')) {
      if(value === null || !['object','function'].includes(typeof value)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, part);
      if(!descriptor || !('value' in descriptor)) return undefined;
      value = descriptor.value;
    }
    return value;
  };
  // Fixed page namespaces plus ones already evidenced by static handlers; no window data enumeration.
  for(const name of ['EVENT','event','PAGE','page','FUNC','fn',...Array.from(parents).slice(0,30)]) {
    const value = ownValue(name);
    if(value === null || typeof value !== 'object') continue;
    for(const key of Object.getOwnPropertyNames(value).slice(0,200)) if(id(key) && isExport(key)) addTarget(name + '.' + key);
  }
  let functionBudget = 150000;
  for(const name of Array.from(targets).slice(0,40)) {
    const value = ownValue(name);
    if(typeof value !== 'function') continue;
    const source = Function.prototype.toString.call(value);
    if(source.length > 40000 || source.length > functionBudget) { output.truncated = true; continue; }
    functionBudget -= source.length;
    const clean = staticWithoutComments(source);
    const code = stripLiterals(clean);
    const facts = {name,calls:[],paths:[],selectors:[],services:[]};
    for(const match of code.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,3})\s*\(/g)) {
      if(fn(match[1]) && !['if','for','while','switch','catch','function'].includes(match[1]) && !facts.calls.includes(match[1]) && facts.calls.length < 60) facts.calls.push(match[1]);
    }
    for(const match of clean.matchAll(/"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g)) {
      const value = match[1] === undefined ? match[2] : match[1];
      if(sameIssuerPath(value) && facts.paths.length < 20 && !facts.paths.includes(value)) { facts.paths.push(value); addPath(value); }
      if(/^SHPPRP0801S[0-9]{2}$/.test(value) && url.hostname.includes('samsungcard') && facts.services.length < 10 && !facts.services.includes(value)) facts.services.push(value);
      const before = clean.slice(Math.max(0,match.index-60), match.index);
      const selector = /^[#.]?[A-Za-z_$][A-Za-z0-9_$-]{0,79}$/.test(value) && !/\d{4,}/.test(value);
      if(selector && /(?:\$|jQuery|querySelector|querySelectorAll|getElementById|getElementsByName)\(\s*$/.test(before) && facts.selectors.length < 60 && !facts.selectors.includes(value)) facts.selectors.push(value);
    }
    output.functions.push(facts);
  }
  if(targets.size > 40) output.truncated = true;
  return output;
})()`

/** Only structural facts cross the MCP boundary; financial data remains inside the browser. */
export async function inspectCardExportContract(tab: Tab): Promise<unknown> {
  try {
    const before = await inspectCardPage(tab)
    if (before.state !== 'ready') return { state: before.state, auth: before.auth }
    const wc = tab.view.webContents
    const url = wc.getURL()
    const raw: unknown = await wc.executeJavaScript(SCRIPT, false)
    if (wc.isDestroyed() || wc.getURL() !== url) return { state: 'navigation_changed' }
    const parsed = exportSchema.safeParse(raw)
    if (!parsed.success) return { state: 'invalid_result' }
    const after = await inspectCardPage(tab)
    if (after.state !== 'ready') return { state: after.state, auth: after.auth }
    if (wc.isDestroyed() || wc.getURL() !== url || after.issuer !== before.issuer)
      return { state: 'navigation_changed' }
    const issuer = before.issuer
    const validPath = (value: string): boolean =>
      issuer === 'hyundai_card'
        ? value.startsWith('/cpa/cb/')
        : issuer === 'lotte_card'
          ? value.startsWith('/app/')
          : /^\/(?:personal\/card\/activity|frontservice)\//.test(value)
    if (
      [...parsed.data.paths, ...parsed.data.functions.flatMap((item) => item.paths)].some(
        (value) => !validPath(value)
      ) ||
      (issuer !== 'samsung_card' && parsed.data.functions.some((item) => item.services.length))
    )
      return { state: 'invalid_result' }
    return {
      state: 'ready',
      issuer,
      export: parsed.data,
      scriptUrls: before.structure?.scriptUrls ?? []
    }
  } catch {
    return { state: 'error' }
  }
}
