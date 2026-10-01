import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ko from '../src/renderer/src/i18n/ko.json'
import type { AiProviderId } from '../src/shared/ai'

const state = vi.hoisted(() => ({
  provider: 'codex_subscription' as AiProviderId,
  authError: 'missing' as 'missing' | 'limit' | null
}))

vi.mock('@renderer/stores/chatStore', () => ({ useChatStore: () => state }))
vi.mock('@renderer/stores/aiStore', () => ({
  useAiStore: (select: (value: typeof state) => unknown) => select(state)
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ko.auth[key.replace('auth.', '') as keyof typeof ko.auth]
  })
}))

import { AuthBanner } from '../src/renderer/src/components/chat/AuthBanner'

describe('구독 제공자에 맞는 인증 안내', () => {
  it('Codex 인증 실패는 Codex 재연결을 안내하고 Claude 로그인·API 키를 권하지 않는다', () => {
    state.provider = 'codex_subscription'
    state.authError = 'missing'
    const html = renderToStaticMarkup(createElement(AuthBanner))
    expect(html).toContain('Codex 구독')
    expect(html).toContain('다시 연결')
    expect(html).not.toContain('claude auth login')
    expect(html).not.toContain('API 키')
  })

  it('Codex 한도 오류는 사용량·초기화 시각 확인을 안내한다', () => {
    state.provider = 'codex_subscription'
    state.authError = 'limit'
    const html = renderToStaticMarkup(createElement(AuthBanner))
    expect(html).toContain('Codex 사용량과 초기화 시각')
    expect(html).not.toContain('API 키')
  })

  it('다른 제공자의 기존 안내와 오류 없는 상태를 유지한다', () => {
    state.provider = 'claude_subscription'
    state.authError = 'missing'
    expect(renderToStaticMarkup(createElement(AuthBanner))).toContain('claude auth login')
    state.authError = null
    expect(renderToStaticMarkup(createElement(AuthBanner))).toBe('')
  })
})
