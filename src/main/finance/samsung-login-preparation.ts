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
