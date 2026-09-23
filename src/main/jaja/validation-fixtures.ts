import type { App, Session } from 'electron'
import {
  enableValidationMockSites,
  isJajaValidation,
  VALIDATION_BACKEND,
  VALIDATION_MOCK_ORIGINS
} from './validation'

// Development-only synthetic sites. The original HTTPS URL is preserved so the
// normal cookie capture/probe policy runs, but no HTTPS request leaves the app.
const SITES = [
  { short: 'musinsa', label: '무신사', domain: 'musinsa.com', ordinal: 1 },
  { short: 'cm29', label: '29CM', domain: '29cm.co.kr', ordinal: 3 },
  { short: 'lotte', label: '롯데온', domain: 'lotteon.com', ordinal: 5 },
  { short: 'abc', label: 'ABC마트', domain: 'a-rt.com', ordinal: 7 }
] as const

type Site = (typeof SITES)[number]
type FixtureCookie = { name: string; value: string; httpOnly: boolean; path: string }

function page(site: Site, current: string): Response {
  const buttons = ['a', 'b'].map(
    (letter) =>
      `<a href="/__validation__/login?accountId=sa_val_${site.short}_${letter}">${letter.toUpperCase()} 계정으로 가상 로그인</a>`
  )
  return new Response(
    `<!doctype html><html lang="ko"><meta charset="utf-8"><title>${site.label} · 검증 전용</title>
    <style>body{font:16px system-ui;background:#f4f6fb;color:#17243a;max-width:780px;margin:64px auto;padding:24px}section{background:white;padding:36px;border-radius:20px;box-shadow:0 4px 24px #152b4d12}b{color:#6747d7}h1{font-size:28px}a{display:inline-block;background:#173f7e;color:white;text-decoration:none;padding:14px 18px;border-radius:10px;margin:8px 8px 8px 0}small{color:#637089;line-height:1.8}code{background:#eaf0f8;padding:6px}</style>
    <section><b>검증 전용 · 운영 미연결</b><h1>${site.label} 가상 로그인</h1><p>현재 계정: <code>${current}</code></p>
    <p>${buttons.join('')}<a href="/__validation__/logout">가상 로그아웃</a></p>
    <small>이 페이지는 컴퓨터 안에서 생성한 모의 사이트입니다. 실제 쇼핑몰에 연결하거나 주문하지 않습니다.<br>아래 계정의 쿠키가 다른 계정 탭과 분리되는지 확인할 수 있습니다. 로그인 후 ‘소싱 계정’에서 확인하세요.</small></section></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  )
}

async function handle(browser: Session, request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (!VALIDATION_MOCK_ORIGINS.has(url.origin) || request.method !== 'GET')
    return new Response('Validation network blocked', { status: 403 })
  const site = SITES.find((item) => url.hostname.endsWith('.' + item.domain))
  if (!site) return new Response('Unsupported synthetic site', { status: 404 })
  if (url.pathname === '/__validation__/login') {
    const accountId = url.searchParams.get('accountId') || ''
    if (!['a', 'b'].some((letter) => accountId === `sa_val_${site.short}_${letter}`))
      return new Response('Synthetic account required', { status: 400 })
    const response = await fetch(`${VALIDATION_BACKEND}/__validation__/fixture/${accountId}`, {
      signal: AbortSignal.timeout(5000),
      redirect: 'error'
    })
    const fixture = await response.json()
    if (
      !response.ok ||
      fixture.synthetic !== true ||
      fixture.accountId !== accountId ||
      !Array.isArray(fixture.cookies)
    )
      throw new Error('Invalid local fixture')
    for (const cookie of fixture.cookies as FixtureCookie[]) {
      if (
        !['jaja_validation', 'mss_mac', 'refresh_token', 'JSESSIONID'].includes(cookie.name) ||
        !/^[a-zA-Z0-9_.:-]+$/.test(cookie.value)
      )
        throw new Error('Invalid synthetic cookie')
      await browser.cookies.set({
        url: url.origin,
        name: cookie.name,
        value: cookie.value,
        domain: '.' + site.domain,
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
        expirationDate: Date.now() / 1000 + 86400 * 14
      })
    }
    await browser.cookies.flushStore()
  }
  if (url.pathname === '/__validation__/logout') {
    const cookies = await browser.cookies.get({ domain: site.domain })
    for (const cookie of cookies)
      await browser.cookies.remove(url.origin + cookie.path, cookie.name)
    await browser.cookies.flushStore()
  }
  const cookies = await browser.cookies.get({ domain: site.domain })
  const marker = cookies.find((cookie) => cookie.name === 'jaja_validation')?.value || ''
  const [accountId, state] = marker.split(':')
  const validId = ['a', 'b'].find((letter) => accountId === `sa_val_${site.short}_${letter}`)
  const protectedPage =
    url.pathname === '/mypage/myreview' ||
    url.pathname.startsWith('/p/review/') ||
    url.pathname === '/api/v4/users/me'
  if (protectedPage) {
    if (!validId || state === 'expired')
      return new Response('Synthetic login required', { status: 401 })
    if (state === 'unavailable') return new Response('Synthetic unavailable', { status: 503 })
    if (site.short === 'cm29') {
      const ordinal = site.ordinal + (validId === 'b' ? 1 : 0)
      return Response.json({ data: { userId: ordinal + 1000, loginId: `synthetic-${ordinal}` } })
    }
  }
  return page(site, validId ? `${site.label} ${validId.toUpperCase()} (${state})` : '로그아웃')
}

export function registerValidationFixtures(app: Pick<App, 'on'>): void {
  if (!isJajaValidation()) return
  app.on('session-created', (browser: Session) => {
    browser.protocol.handle('https', async (request) => {
      try {
        return await handle(browser, request)
      } catch {
        return new Response('Local validation fixture unavailable', { status: 503 })
      }
    })
    enableValidationMockSites(browser)
  })
}
