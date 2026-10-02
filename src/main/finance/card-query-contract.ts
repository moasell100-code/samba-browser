import type { Tab } from '../browser/tab-manager'
import { inspectCardPage } from './card-page-diagnostics'

// Inspection only: do not invoke functions, handlers, or send page requests.
// Restrict this diagnostic to static query functions. Never read form values.
const SCRIPT = String.raw`(() => {
  const pageUrl = new URL(location.href);
  const allowed = !pageUrl.username && !pageUrl.password && (
    pageUrl.origin === 'https://www.lottecard.co.kr' && pageUrl.pathname === '/app/LPMCDAA_V100.lc' ||
    ['https://www.hyundaicard.com', 'https://hyundaicard.com'].includes(pageUrl.origin) && pageUrl.pathname === '/cpa/cb/CPACB0101_01.hc' ||
    pageUrl.origin === 'https://www.samsungcard.com' && ['/personal/card/activity/UHPPRP0801M0.jsp', '/personal/card/activity/UHPPRP0801D0.jsp', '/personal/card/activity/UHPPRP0801D8.jsp'].includes(pageUrl.pathname)
  );
  if (!allowed) return { state: 'unsupported', auth: 'unknown' };
  const targets = location.hostname.includes('lottecard')
    ? ['fnSetFormData','ajaxSearchFilterCallBack','ajaxInquryAprUseListCallBack','setAprUseDetail','svcf_Ajax','svcf_AjaxParam','fnValidateInquryDate','fnCheckOver12Month','fnSearchFilter','fnSearchSetting','fnAprUseList','fnSearch','fnMore','fnGetList','fnUseList']
    : ['cardSelect','convertGeneralApprovalItem','convertTrafficItem','convertHipassItem','convertPurchaseItem','recentList','rcntSummaryInfo','goFilter','goAjax','getDate','getUseGb','getUseTypeNm'];
  const controls = location.hostname.includes('lottecard')
    ? ['searchFilterBtn','aprUseMoreBtn'] : ['goFilter'];
  const fields = ['form1','LPMCDAAAprUseList','pageNo','pageRows','nextKey','schDv','stDv','useDv','useCdDv','uplDv','ptnBnkYn','sortDv','sortObj','listClsf','dtClsf','zoneClsf','useClsf','usplClsf','sortType','dmfrClsf','srtDt','startDt','endDt','inqTeDt','iqrySrtDt','iqryEndDt','startDtShow','endDtShow','crno','encCdno','Content','Status','code','message'];
  const literals = new Set([...fields, ...fields.map(f => '#' + f), '', '0','1','2','3','4','5','6','7','8','9','00','01','02','03','04','05','06','07','08','09','10','20','30','Y','N','KRW','POST','GET','승인','취소','정상','승인취소','취소완료','부분취소','전체','일시불','YYYYMMDD','YYYYMMDDHHmmss','YYYY-MM-DD']);
  const clean = source => source.includes(String.fromCharCode(96)) ? '[template source omitted]' : source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\.|[^\x60\\])*\x60/g, (token, offset) => {
    if (token.startsWith('//') || token.startsWith('/*')) return '';
    const value = token.slice(1, -1);
    const publicMarkupText = value.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, '').replace(/\s+/g, '');
    if (value.includes('<') && ['원','국내','해외','승인','취소','보유카드전체'].includes(publicMarkupText)) return JSON.stringify('[markup omitted]' + publicMarkupText);
    // Static public currency/region comparisons only, never current form or account values.
    if (/^[A-Z]{1,6}$/.test(value) && (/\.(?:dmfrClsf|dmfrClsfCd|acplCrncCd|bllCrncCd)\s*={2,3}\s*$/.test(source.slice(Math.max(0, offset - 80), offset)) || /^\s*={2,3}\s*[A-Za-z_$][\w$]*\.(?:dmfrClsf|dmfrClsfCd|acplCrncCd|bllCrncCd)\b/.test(source.slice(offset + token.length, offset + token.length + 80)))) return JSON.stringify(value);
    if (literals.has(value) || /^\/(?:cpa\/cb|app)\/[A-Za-z_][A-Za-z0-9_]{1,60}\.(?:hc|lc|json|ajax|do)$/.test(value) && !/\d{8,}/.test(value)) return JSON.stringify(value);
    return '"[literal omitted]"';
  }).replace(/\b\d{4,}\b/g, '[number omitted]');
  const result = { functions: [], handlers: [], paths: [], filterLabels: [] };
  if (location.hostname === 'www.lottecard.co.kr') {
    const publicLabels = new Set(['전체','신용카드','체크카드','국내','해외','승인','취소','정상','일시불','할부','일시불+할부','일시불/할부','단기카드대출','장기카드대출','단기카드대출(현금서비스)','장기카드대출(카드론)']);
    for (const name of ['useCdDvRadio','uplDvRadio','stDvRadio','useDvRadio']) {
      const labels = Array.from(document.querySelectorAll('input[type="radio"][name="' + name + '"]')).slice(0, 10).map(input => {
        const label = Array.from(input.labels || []).map(item => item.textContent || '').join('').replace(/\s+/g, '');
        return publicLabels.has(label) ? label : 'unrecognized';
      });
      result.filterLabels.push({ name, labels });
    }
  }
  const sources = Array.from(document.scripts).filter(s => !s.src).map(s => s.textContent || '').filter(s => s.length < 250000);
  // Discover names only from static declarations. Never enumerate/read window data.
  for (const source of sources) {
    for (const m of source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (/^(?:fn)?(?:go|search|inq|query|more|next|load|fetch|list|aprUse|getUse|getApr|cardUse)/i.test(m[1]) && !/login|auth|pass|pay|slip|excel|download/i.test(m[1]) && !targets.includes(m[1])) targets.push(m[1]);
      if (location.hostname.includes('hyundaicard') && !targets.includes(m[1]) && !/login|auth|pass|pay|slip|excel|download/i.test(m[1])) {
        const candidate = Object.getOwnPropertyDescriptor(window, m[1]);
        if (candidate && typeof candidate.value === 'function') {
          const code = Function.prototype.toString.call(candidate.value);
          if ((/vldCardList/.test(code) || /['"]#?dmfrClsf['"]/.test(code)) && code.length < 30000) targets.push(m[1]);
        }
      }
    }
    for (const m of source.matchAll(/["'](\/(?:cpa\/cb|app)\/[A-Za-z_][A-Za-z0-9_]{1,60}\.(?:hc|lc|json|ajax|do))["']/g)) {
      if (!/\d{8,}/.test(m[1]) && !result.paths.includes(m[1])) result.paths.push(m[1]);
    }
  }
  let budget = 150000;
  for (const name of targets.slice(0, 40)) {
    const descriptor = Object.getOwnPropertyDescriptor(window, name);
    if (!descriptor || typeof descriptor.value !== 'function') continue;
    const source = Function.prototype.toString.call(descriptor.value);
    if (source.length > 90000 || source.length > budget) continue;
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
