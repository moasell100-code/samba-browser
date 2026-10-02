import type { WebContents } from 'electron'
import type { Tab } from '../browser/tab-manager'
import { ensureDebuggerAttached } from '../browser/emulation'
import type { SamsungLoginOutcome } from './samsung-login-preparation'

const LOGIN = 'https://www.samsungcard.com/personal/login/UHPPCO0301M0.jsp'
const observers = new WeakSet<WebContents>()

export interface SamsungLoginAlertObserver {
  getOutcome: () => SamsungLoginOutcome
  dispose: () => void
}

function loginUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return !url.username && !url.password && url.origin + url.pathname === LOGIN
  } catch {
    return false
  }
}

function own(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined
}

function classify(message: string): SamsungLoginOutcome {
  if (message.length > 4000) return 'unknown'
  const text = message.replace(/\s+/g, '')
  const matches = new Set<SamsungLoginOutcome>()
  if (/(?:아이디|비밀번호|ID).{0,60}(?:일치하지|잘못입력|틀렸|틀린|실패횟수|오류횟수)/i.test(text))
    matches.add('wrong_credentials')
  if (
    /(?:아이디|비밀번호|ID)(?:를|을)?(?:입력해주세요|입력해주시|입력하여|정확하게입력|정확히입력)/i.test(
      text
    )
  )
    matches.add('input_required')
  if (
    /(?:보안프로그램|키보드보안|nProtect|TouchEn|NOS)/i.test(text) &&
    /(?:설치|실행|업데이트)(?:가|를|이)?(?:필요|필수|되지않|되어있지않|되지않았|해주세요|해주시|하여주시|해야|하세요)|미설치/.test(
      text
    )
  )
    matches.add('security_program_required')
  if (
    /(?:추가인증|추가본인확인|본인인증|휴대폰인증|OTP)/i.test(text) &&
    /필요|진행해|완료해|입력해|요청|해주시|해야/.test(text)
  )
    matches.add('additional_auth')
  if (
    /(?:보안문자|자동입력방지|자동등록방지|captcha)/i.test(text) &&
    /입력|확인|인증|필요/.test(text)
  )
    matches.add('captcha')
  return matches.size === 1 ? [...matches][0] : 'unknown'
}

/** A single login's new alert events only. No dialog history, messages, credentials or logs. */
export async function observeSamsungLoginAlerts(
  tab: Tab,
  options: { signal?: AbortSignal } = {}
): Promise<SamsungLoginAlertObserver> {
  let outcome: SamsungLoginOutcome = 'unknown'
  let active = false
  let armed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let wc: WebContents | undefined
  const outcomes = new Set<SamsungLoginOutcome>()
  const dispose = (): void => {
    if (!active || !wc) return
    active = false
    armed = false
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    try {
      wc.debugger.removeListener('message', onMessage)
      wc.debugger.removeListener('detach', onStop)
    } catch {
      /* Already destroyed. */
    }
    try {
      wc.removeListener('destroyed', onStop)
      wc.removeListener('render-process-gone', onStop)
      wc.removeListener('did-navigate', onNavigate)
    } catch {
      /* Already destroyed. */
    }
    observers.delete(wc)
  }
  const onStop = (): void => {
    dispose()
  }
  const onAbort = (): void => {
    if (outcome === 'unknown') outcome = 'cancelled'
    dispose()
  }
  const onNavigate = (): void => {
    if (wc && (wc.isDestroyed() || !loginUrl(wc.getURL()))) dispose()
  }
  const context = (): boolean => {
    try {
      return (
        active && !!wc && !wc.isDestroyed() && !options.signal?.aborted && loginUrl(wc.getURL())
      )
    } catch {
      return false
    }
  }
  const onMessage = (
    _event: unknown,
    method: string,
    params: unknown,
    sessionId?: string
  ): void => {
    if (!armed || method !== 'Page.javascriptDialogOpening' || sessionId || !context()) return
    if (own(params, 'type') !== 'alert' || !loginUrl(own(params, 'url'))) return
    const message = own(params, 'message')
    if (typeof message !== 'string') return
    const found = classify(message)
    outcomes.add(found)
    outcome = outcomes.size === 1 ? found : 'unknown'
    // A native alert has only acknowledgement. Never handle confirm/prompt/beforeunload.
    try {
      void wc!.debugger
        .sendCommand('Page.handleJavaScriptDialog', { accept: true })
        .catch(() => undefined)
    } catch {
      /* No raw protocol error leaves this observer. */
    }
  }
  const handle: SamsungLoginAlertObserver = { getOutcome: () => outcome, dispose }
  if (options.signal?.aborted) {
    outcome = 'cancelled'
    return handle
  }
  try {
    wc = tab.view.webContents
    if (!wc || wc.isDestroyed() || !loginUrl(wc.getURL())) {
      outcome = 'unsupported'
      return handle
    }
    if (observers.has(wc) || !ensureDebuggerAttached(wc)) {
      outcome = 'unavailable'
      return handle
    }
    observers.add(wc)
    active = true
    wc.debugger.on('message', onMessage)
    wc.debugger.on('detach', onStop)
    wc.on('destroyed', onStop)
    wc.on('render-process-gone', onStop)
    wc.on('did-navigate', onNavigate)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(dispose, 120_000)
    timer.unref?.()
    let enableTimer: ReturnType<typeof setTimeout> | undefined
    let enableAbort: (() => void) | undefined
    try {
      await Promise.race([
        wc.debugger.sendCommand('Page.enable'),
        new Promise<never>((_, reject) => {
          enableTimer = setTimeout(() => reject(new Error('enable_timeout')), 10_000)
          enableTimer.unref?.()
          enableAbort = () => reject(new Error('enable_cancelled'))
          if (options.signal?.aborted) enableAbort()
          else options.signal?.addEventListener('abort', enableAbort, { once: true })
        })
      ])
    } finally {
      clearTimeout(enableTimer)
      if (enableAbort) options.signal?.removeEventListener('abort', enableAbort)
    }
    if (!context()) {
      if (outcome === 'unknown') outcome = options.signal?.aborted ? 'cancelled' : 'unavailable'
      dispose()
    } else armed = true
  } catch {
    outcome = options.signal?.aborted ? 'cancelled' : 'unavailable'
    dispose()
  }
  return handle
}
