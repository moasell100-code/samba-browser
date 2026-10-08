import type { Tab } from '../browser/tab-manager'
import { inspectCardPage } from './card-page-diagnostics'

// Inspection only: do not invoke functions, handlers, or send page requests.
// Restrict this diagnostic to static query functions and public option markup.
// Never read mutable form values or customer/account fields.
const SCRIPT = String.raw`(() => {
  const pageUrl = new URL(location.href);
  const allowed = !pageUrl.username && !pageUrl.password && (
    pageUrl.origin === 'https://www.lottecard.co.kr' && pageUrl.pathname === '/app/LPMCDAA_V100.lc' ||
    ['https://www.hyundaicard.com', 'https://hyundaicard.com'].includes(pageUrl.origin) && pageUrl.pathname === '/cpa/cb/CPACB0101_01.hc' ||
    pageUrl.origin === 'https://www.samsungcard.com' && ['/personal/card/activity/UHPPRP0801M0.jsp', '/personal/card/activity/UHPPRP0801D0.jsp', '/personal/card/activity/UHPPRP0801D8.jsp'].includes(pageUrl.pathname)
  );
  if (!allowed) return { state: 'unsupported', auth: 'unknown' };
  const targets = location.hostname.includes('lottecard')
    ? ['fnSaveExcel','svcf_Submit','fnSetFormData','ajaxSearchFilterCallBack','ajaxInquryAprUseListCallBack','setAprUseDetail','svcf_Ajax','svcf_AjaxParam','fnValidateInquryDate','fnCheckOver12Month','fnSearchFilter','fnSearchSetting','fnAprUseList','fnSearch','fnMore','fnGetList','fnUseList']
    : ['excelAction','cardSelect','convertGeneralApprovalItem','convertTrafficItem','convertHipassItem','convertPurchaseItem','recentList','rcntSummaryInfo','goFilter','goAjax','getDate','getUseGb','getUseTypeNm'];
  const controls = location.hostname.includes('lottecard')
    ? ['searchFilterBtn','aprUseMoreBtn'] : ['goFilter','listClsf_01','listClsf_02'];
  const fields = ['form1','LPMCDAAAprUseList','pageNo','pageRows','nextKey','schDv','stDv','useDv','useCdDv','uplDv','ptnBnkYn','sortDv','sortObj','listClsf','dtClsf','zoneClsf','useClsf','usplClsf','sortType','dmfrClsf','srtDt','startDt','endDt','inqTeDt','iqrySrtDt','iqryEndDt','startDtShow','endDtShow','crno','encCdno','Content','Status','code','message'];
  const literals = new Set([...fields, ...fields.map(f => '#' + f), 'action','method','target','_self','_blank','#usplClsf_04','#listClsf_01',':checked','', '0','1','2','3','4','5','6','7','8','9','00','01','02','03','04','05','06','07','08','09','10','20','30','Y','N','KRW','POST','GET','승인','취소','정상','승인취소','취소완료','부분취소','전체','일시불','YYYYMMDD','YYYYMMDDHHmmss','YYYY-MM-DD']);
  const clean = source => source.includes(String.fromCharCode(96)) ? '[template source omitted]' : source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\.|[^\x60\\])*\x60/g, (token, offset) => {
    if (token.startsWith('//') || token.startsWith('/*')) return '';
    const value = token.slice(1, -1);
    const publicMarkupText = value.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, '').replace(/\s+/g, '');
    if (/^[a-zA-Z][a-zA-Z0-9_-]{0,32}$/.test(value) && /\.data\(\s*$/.test(source.slice(Math.max(0,offset-30),offset))) return JSON.stringify(value);
    if (value.includes('<') && ['원','국내','해외','승인','취소','보유카드전체'].includes(publicMarkupText)) return JSON.stringify('[markup omitted]' + publicMarkupText);
    // Static public currency/region comparisons only, never current form or account values.
    if (/^[A-Z]{1,6}$/.test(value) && (/\.(?:dmfrClsf|dmfrClsfCd|acplCrncCd|bllCrncCd)\s*={2,3}\s*$/.test(source.slice(Math.max(0, offset - 80), offset)) || /^\s*={2,3}\s*[A-Za-z_$][\w$]*\.(?:dmfrClsf|dmfrClsfCd|acplCrncCd|bllCrncCd)\b/.test(source.slice(offset + token.length, offset + token.length + 80)))) return JSON.stringify(value);
    if (literals.has(value) || /^\/(?:cpa\/cb|app)\/[A-Za-z_][A-Za-z0-9_]{1,60}\.(?:hc|lc|json|ajax|do)$/.test(value) && !/\d{8,}/.test(value)) return JSON.stringify(value);
    return '"[literal omitted]"';
  }).replace(/\b\d{4,}\b/g, '[number omitted]');
  const result = { functions: [], handlers: [], paths: [], filterLabels: [], publicStatusOptions: [], cardSelectorSchema: [] };
  if (location.hostname === 'www.lottecard.co.kr') {
    for (const input of Array.from(document.querySelectorAll('input[name="useCarditem"]')).slice(0,20)) {
      const root = input.closest('li') || input.parentElement;
      if (!root) continue;
      const nodes = [root,...root.querySelectorAll('*')].slice(0,50);
      const facts = nodes.map(node => ({tag:node.tagName, classes:Array.from(node.classList).filter(name=>/^[a-zA-Z][a-zA-Z_-]{0,40}$/.test(name)).slice(0,5), dataNames:node.getAttributeNames().filter(name=>/^data-[a-z-]{1,40}$/.test(name))})).filter(node=>node.dataNames.length || ['INPUT','LABEL'].includes(node.tag));
      const label = Array.from(input.labels || []).map(item=>item.textContent || '').join(' ');
      const words = ['이전','해지','정지','보유','전체','선불','후불','신용','체크','가족'];
      result.cardSelectorSchema.push({rootTag:root.tagName,nodes:facts,hasMaskedNumber:/[\d*]{4}[- ]?[\d*]{4}[- ]?[\d*]{4}[- ]?[\d*]{4}/.test(label),hasSuffix:/\([\d*]{4}\)/.test(label),hasFourDigitToken:/(?<![\d*])[\d*]{4}(?![\d*])/.test(label), numberTokenLengths:(label.match(/[\d*]+/g)||[]).slice(0,12).map(token=>Math.min(token.length,30)),publicTokens:words.filter(word=>label.includes(word))});
    }
    const publicLabels = new Set(['전체','신용카드','체크카드','국내','해외','승인','취소','정상','일시불','할부','일시불+할부','일시불/할부','단기카드대출','장기카드대출','단기카드대출(현금서비스)','장기카드대출(카드론)']);
    for (const name of ['useCdDvRadio','uplDvRadio','stDvRadio','useDvRadio']) {
      const labels = Array.from(document.querySelectorAll('input[type="radio"][name="' + name + '"]')).slice(0, 10).map(input => {
        const label = Array.from(input.labels || []).map(item => item.textContent || '').join('').replace(/\s+/g, '');
        return publicLabels.has(label) ? label : 'unrecognized';
      });
      result.filterLabels.push({ name, labels });
    }
    // The public status radio's static enum attribute is distinct from current
    // form state. It is needed to verify the cancellation-only query contract.
    for (const input of Array.from(document.querySelectorAll('input[type="radio"][name="stDvRadio"]')).slice(0,10)) {
      const label = Array.from(input.labels || []).map(item=>item.textContent || '').join('').replace(/\s+/g,'');
      const code = input.getAttribute('value');
      if (['전체','정상','취소'].includes(label) && typeof code === 'string' && /^(?:[0-9]{1,2}|[A-Z])$/.test(code))
        result.publicStatusOptions.push({ label, code });
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
  if (location.hostname.includes('hyundaicard')) {
    const jquery = Object.getOwnPropertyDescriptor(window, 'jQuery');
    const ajax = jquery && typeof jquery.value === 'function' && Object.getOwnPropertyDescriptor(jquery.value, 'hcAjax');
    if (ajax && typeof ajax.value === 'function') {
      const source = Function.prototype.toString.call(ajax.value);
      if (source.length <= 40000 && source.length <= budget) result.functions.push({ name: 'jQuery.hcAjax', source: clean(source) });
    }
  }
  for (const id of controls) {
    const el = document.getElementById(id);
    const jq = window.jQuery;
    if (!el || !jq || typeof jq._data !== 'function') continue;
    const events = jq._data(el, 'events');
    for (const entry of [...(events && events.click || []), ...(events && events.change || [])].slice(0, 10)) {
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
  if (state.issuer === 'samsung_card') {
    // Public, fixed JavaScript only. No session cookie, form, request body or
    // customer data is sent. It explains the official cancellation renderer.
    const response = await fetch(
      'https://static12.samsungcard.com/js/personal/card/activity/UHPPRP0801D8.js',
      { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000) }
    )
    if (!response.ok) throw new Error('Card diagnostics unavailable')
    const source = await response.text()
    if (source.length > 250000) throw new Error('Card diagnostics unavailable')
    const lines = source.split(/\r?\n/)
    const indices = new Set<number>()
    for (let index = 0; index < lines.length; index++) {
      if (
        /canRcpdt|aprAm|canProcsStsC|poCanDvC|inqrStrtdt|inqrEnddt|SHPPRP0801S12|취소일|취소금액/.test(
          lines[index]
        )
      )
        for (let n = Math.max(0, index - 2); n <= Math.min(lines.length - 1, index + 2); n++)
          indices.add(n)
    }
    if (wc.isDestroyed() || wc.getURL() !== url) throw new Error('Card tab changed')
    return {
      ...(result && typeof result === 'object' ? result : {}),
      publicCancellationSource: [...indices].slice(0, 100).map((index) => ({
        line: index + 1,
        source: lines[index].slice(0, 500)
      }))
    }
  }
  return result
}
