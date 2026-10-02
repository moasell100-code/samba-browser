import type { Tab } from '../browser/tab-manager'
import { inspectCardPage } from './card-page-diagnostics'

// Inspection only: do not invoke functions, handlers, or send page requests.
// Restrict this diagnostic to static query functions. Never read form values.
const SCRIPT = String.raw`(() => {
  const targets = location.hostname.includes('lottecard')
    ? ['fnSearchFilter','fnSearchSetting','fnAprUseList','fnSearch','fnMore','fnGetList','fnUseList']
    : ['getUseGb','getUseTypeNm','getPrttPayPosbInfo','getUseGbforAcqrItm','getDate'];
  const controls = location.hostname.includes('lottecard')
    ? ['searchFilterBtn','aprUseMoreBtn'] : ['goFilter'];
  const fields = ['form1','LPMCDAAAprUseList','pageNo','pageRows','nextKey','schDv','stDv','useDv','useCdDv','uplDv','ptnBnkYn','sortDv','sortObj','listClsf','dtClsf','zoneClsf','useClsf','usplClsf','sortType','dmfrClsf','srtDt','startDt','endDt','inqTeDt','iqrySrtDt','iqryEndDt','startDtShow','endDtShow','crno','encCdno','Content','Status','code','message'];
  const literals = new Set([...fields, ...fields.map(f => '#' + f)]);
  const clean = source => source.includes(String.fromCharCode(96)) ? '[template source omitted]' : source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\.|[^\x60\\])*\x60/g, token => {
    if (token.startsWith('//') || token.startsWith('/*')) return '';
    const value = token.slice(1, -1);
    if (literals.has(value) || /^\/(?:cpa\/cb|app)\/[A-Za-z_][A-Za-z0-9_]{1,60}\.(?:hc|lc|json|ajax|do)$/.test(value) && !/\d{8,}/.test(value)) return JSON.stringify(value);
    return '"[literal omitted]"';
  }).replace(/\b\d{4,}\b/g, '[number omitted]');
  const result = { functions: [], handlers: [], paths: [] };
  const sources = Array.from(document.scripts).filter(s => !s.src).map(s => s.textContent || '').filter(s => s.length < 250000);
  // Discover names only from static declarations. Never enumerate/read window data.
  for (const source of sources) {
    for (const m of source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (/^(?:fn)?(?:search|inq|query|more|next|load|fetch|list|aprUse|getUse|getApr|cardUse)/i.test(m[1]) && !/login|auth|pass|pay|slip|excel|download/i.test(m[1]) && !targets.includes(m[1])) targets.push(m[1]);
    }
    for (const m of source.matchAll(/["'](\/(?:cpa\/cb|app)\/[A-Za-z_][A-Za-z0-9_]{1,60}\.(?:hc|lc|json|ajax|do))["']/g)) {
      if (!/\d{8,}/.test(m[1]) && !result.paths.includes(m[1])) result.paths.push(m[1]);
    }
  }
  let budget = 50000;
  for (const name of targets.slice(0, 40)) {
    const descriptor = Object.getOwnPropertyDescriptor(window, name);
    if (!descriptor || typeof descriptor.value !== 'function') continue;
    const source = Function.prototype.toString.call(descriptor.value);
    if (source.length > 18000 || source.length > budget) continue;
    budget -= source.length;
    result.functions.push({ name, source: clean(source) });
  }
  for (const id of controls) {
    const el = document.getElementById(id);
    const jq = window.jQuery;
    if (!el || !jq || typeof jq._data !== 'function') continue;
    const events = jq._data(el, 'events');
    for (const entry of (events && events.click || []).slice(0, 5)) {
      if (typeof entry.handler !== 'function') continue;
      const source = Function.prototype.toString.call(entry.handler);
      if (source.length > 10000 || source.length > budget) continue;
      budget -= source.length;
      result.handlers.push({ id, source: clean(source) });
    }
  }
  return result;
})()`

export async function inspectCardQueryContract(tab: Tab): Promise<unknown> {
  const state = await inspectCardPage(tab)
  if (state.state !== 'ready') return { state: state.state, auth: state.auth }
  const wc = tab.view.webContents
  const url = wc.getURL()
  const result: unknown = await wc.executeJavaScript(SCRIPT, false)
  if (wc.isDestroyed() || wc.getURL() !== url) throw new Error('Card tab changed')
  return result
}
