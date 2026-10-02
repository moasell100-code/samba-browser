import { z } from 'zod'
import type { Tab } from '../browser/tab-manager'

const LOGIN = 'https://www.samsungcard.com/personal/login/UHPPCO0301M0.jsp'
const snapshot = z
  .object({
    state: z.enum([
      'ready',
      'id_tab_available',
      'tab_unverified',
      'tab_ambiguous',
      'form_unverified',
      'tab_not_ready',
      'unsupported',
      'navigation_changed',
      'cancelled',
      'unavailable'
    ]),
    tab: z.enum(['id_tab', 'ge_lgn_ctf_id', 'unverified', 'none', 'multiple'])
  })
  .strict()
export type SamsungLoginPreparation = z.infer<typeof snapshot>

const outcomeSchema = z.enum([
  'wrong_credentials',
  'input_required',
  'security_program_required',
  'additional_auth',
  'captcha',
  'unknown',
  'unsupported',
  'navigation_changed',
  'cancelled',
  'unavailable'
])
export type SamsungLoginOutcome = z.infer<typeof outcomeSchema>

function loginUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return !url.username && !url.password && url.origin + url.pathname === LOGIN
  } catch {
    return false
  }
}

// This fixed program inspects public UI structure only. It never reads form values,
// invokes login, or changes credentials. Its only optional action is the known ID tab.
function script(select: boolean): string {
  return String.raw`(() => {
    const select = ${select};
    const url = new URL(location.href);
    if (self !== top || url.username || url.password || url.origin + url.pathname !== '${LOGIN}') return {state:'unsupported',tab:'none'};
    const visible = element => {
      for (let node = element; node; node = node.parentElement) {
        if (node.hidden || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true' || (node.tagName === 'INPUT' && node.getAttribute('type') === 'hidden')) return false;
        const style = getComputedStyle(node);
        if (style.display === 'none' || ['hidden','collapse'].includes(style.visibility) || (style.opacity !== '' && Number(style.opacity) === 0) || style.clip === 'rect(0px, 0px, 0px, 0px)') return false;
        if (style.position === 'absolute' && (parseFloat(style.left) <= -9999 || parseFloat(style.top) <= -9999)) return false;
      }
      return true;
    };
    const all = selector => Array.from(document.querySelectorAll(selector));
    const nodes = all('a,button,[role="tab"],[role="button"],[role="link"]');
    if (nodes.length > 500) return {state:'tab_unverified',tab:'unverified'};
    const labels = new Set(['아이디','아이디 로그인','ID 로그인']);
    const candidates = nodes.filter(node => visible(node) && labels.has((node.textContent || '').trim()));
    const knownTab = node => node.id === 'id_tab' ? 'id_tab' : node.parentElement?.tagName === 'LI' && node.parentElement.id === 'ge_lgn_ctf_id' ? 'ge_lgn_ctf_id' : 'unverified';
    const tab = candidates.length > 1 ? 'multiple' : candidates.length === 0 ? 'none' : knownTab(candidates[0]);
    const forms = all('form#npPfs');
    const usernames = all('#dgtlMmbrId');
    const passwords = all('#pswde');
    const buttons = all('#btn_login');
    const panels = all('#login02');
    const formKnown = forms.length === 1 && usernames.length === 1 && passwords.length === 1 && buttons.length === 1 &&
      usernames[0].tagName === 'INPUT' && ['text',''].includes(usernames[0].getAttribute('type') || '') &&
      passwords[0].tagName === 'INPUT' && passwords[0].getAttribute('type') === 'password' &&
      buttons[0].tagName === 'BUTTON' && buttons[0].getAttribute('type') === 'button' && (buttons[0].textContent || '').trim() === '로그인' &&
      [usernames[0], passwords[0], buttons[0]].every(node => forms[0].contains(node));
    if (formKnown && [forms[0],usernames[0],passwords[0],buttons[0]].every(node => visible(node) && !node.disabled)) return {state:'ready',tab};
    if (candidates.length > 1) return {state:'tab_ambiguous',tab};
    if (candidates.length !== 1) return {state:'tab_unverified',tab};
    const target = candidates[0];
    const knownUniqueTab = tab === 'id_tab' ? all('#id_tab').length === 1 : tab === 'ge_lgn_ctf_id' && all('#ge_lgn_ctf_id').length === 1 && target.parentElement?.querySelectorAll('a[href="#login02"]').length === 1;
    const exact = knownUniqueTab && target.tagName === 'A' && target.getAttribute('href') === '#login02' && target.getAttribute('aria-disabled') !== 'true' &&
      panels.length === 1 && formKnown && [usernames[0],passwords[0],buttons[0]].every(node => panels[0].contains(node));
    if (!exact) return {state:formKnown ? 'tab_unverified' : 'form_unverified',tab};
    if (select) { target.click(); return {state:'tab_not_ready',tab}; }
    return {state:'id_tab_available',tab};
  })()`
}

async function execute(
  tab: Tab,
  select: boolean,
  signal?: AbortSignal
): Promise<SamsungLoginPreparation> {
  if (signal?.aborted) return { state: 'cancelled', tab: 'none' }
  try {
    const wc = tab.view.webContents
    if (!wc || wc.isDestroyed() || !loginUrl(wc.getURL()))
      return { state: 'unsupported', tab: 'none' }
    const initial = wc.getURL()
    const value: unknown = await wc.executeJavaScript(script(select), false)
    if (signal?.aborted) return { state: 'cancelled', tab: 'none' }
    if (wc.isDestroyed() || wc.getURL() !== initial)
      return { state: 'navigation_changed', tab: 'none' }
    const parsed = snapshot.safeParse(value)
    return parsed.success ? parsed.data : { state: 'unavailable', tab: 'none' }
  } catch {
    return { state: 'unavailable', tab: 'none' }
  }
}

/** Read-only public state; suitable for a metadata-only diagnostic. */
export function inspectSamsungIdLogin(
  tab: Tab,
  options: { signal?: AbortSignal } = {}
): Promise<SamsungLoginPreparation> {
  return execute(tab, false, options.signal)
}

/** Select the verified official ID tab once, then wait for its existing form to show. */
export async function prepareSamsungIdLogin(
  tab: Tab,
  options: { signal?: AbortSignal } = {}
): Promise<SamsungLoginPreparation> {
  const before = await execute(tab, false, options.signal)
  if (before.state !== 'id_tab_available') return before
  const selected = await execute(tab, true, options.signal)
  if (selected.state !== 'tab_not_ready') return selected
  for (let attempt = 0; attempt < 20; attempt++) {
    const current = await execute(tab, false, options.signal)
    if (current.state === 'ready' || current.state !== 'id_tab_available') return current
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
  }
  return { state: 'tab_not_ready', tab: selected.tab }
}

// Samsung's public showMessage currently calls native alert(). This DOM reader cannot
// recover a dismissed native alert and must never infer an error from routine body text.
const OUTCOME_SCRIPT = String.raw`(() => {
  const url = new URL(location.href);
  if (self !== top || url.username || url.password || url.origin + url.pathname !== '${LOGIN}') return 'unsupported';
  const visible = element => {
    for (let node = element; node; node = node.parentElement) {
      if (node.hidden || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true' || (node.tagName === 'INPUT' && node.getAttribute('type') === 'hidden')) return false;
      const style = getComputedStyle(node);
      if (style.display === 'none' || ['hidden','collapse'].includes(style.visibility) || (style.opacity !== '' && Number(style.opacity) === 0) || style.clip === 'rect(0px, 0px, 0px, 0px)') return false;
      if (style.position === 'absolute' && (parseFloat(style.left) <= -9999 || parseFloat(style.top) <= -9999)) return false;
    }
    return true;
  };
  const alerts = Array.from(document.querySelectorAll('[role="alert"],[role="alertdialog"],dialog[open]')).filter(visible);
  if (alerts.length > 10) return 'unknown';
  const outcomes = new Set();
  for (const alert of alerts) {
    let text = '', visited = 0, limited = false;
    const read = node => {
      if (++visited > 500 || text.length > 4000) { limited = true; return; }
      if (node.nodeType === 3) { text += node.textContent || ''; return; }
      if (node.nodeType !== 1 || !visible(node) || ['INPUT','TEXTAREA','SELECT','SCRIPT','STYLE','TEMPLATE','NOSCRIPT'].includes(node.tagName) || node.hasAttribute('contenteditable')) return;
      for (const child of node.childNodes) read(child);
    };
    read(alert);
    if (limited || text.length > 4000) return 'unknown';
    const message = text.replace(/\s+/g, '');
    if (/(?:아이디|비밀번호|ID).{0,60}(?:일치하지|잘못입력|틀렸|틀린|실패횟수|오류횟수)/i.test(message)) outcomes.add('wrong_credentials');
    if (/(?:아이디|비밀번호|ID)(?:를|을)?(?:입력해주세요|입력해주시|입력하여|정확하게입력|정확히입력)/i.test(message)) outcomes.add('input_required');
    if (/(?:보안프로그램|키보드보안|nProtect|TouchEn|NOS)/i.test(message) && /(?:설치|실행|업데이트)(?:가|를|이)?(?:필요|필수|되지않|되어있지않|되지않았|해주세요|해주시|하여주시|해야|하세요)|미설치/.test(message)) outcomes.add('security_program_required');
    if (/(?:추가인증|추가본인확인|본인인증|휴대폰인증|OTP)/i.test(message) && /필요|진행해|완료해|입력해|요청|해주시|해야/.test(message)) outcomes.add('additional_auth');
    if (/(?:보안문자|자동입력방지|자동등록방지|captcha)/i.test(message) && /입력|확인|인증|필요/.test(message)) outcomes.add('captcha');
  }
  return outcomes.size === 1 ? [...outcomes][0] : 'unknown';
})()`

/** Classify only a currently visible alert; no credentials, raw messages, or page data escape. */
export async function inspectSamsungLoginOutcome(
  tab: Tab,
  options: { signal?: AbortSignal } = {}
): Promise<SamsungLoginOutcome> {
  if (options.signal?.aborted) return 'cancelled'
  try {
    const wc = tab.view.webContents
    if (!wc || wc.isDestroyed() || !loginUrl(wc.getURL())) return 'unsupported'
    const initial = wc.getURL()
    const value: unknown = await wc.executeJavaScript(OUTCOME_SCRIPT, false)
    if (options.signal?.aborted) return 'cancelled'
    if (wc.isDestroyed() || wc.getURL() !== initial) return 'navigation_changed'
    const parsed = outcomeSchema.safeParse(value)
    return parsed.success ? parsed.data : 'unavailable'
  } catch {
    return 'unavailable'
  }
}
