// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, getByRole, getAllByRole, queryByRole, within } from '@testing-library/dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JajaAccountView, JajaStatus } from '../src/shared/jaja'

const ui = vi.hoisted(() => ({ setView: vi.fn() }))
vi.mock('@renderer/stores/uiStore', () => ({
  useUiStore: (select: (state: typeof ui) => unknown): unknown => select(ui)
}))
import { JajaAccountsPage } from '../src/renderer/src/pages/JajaAccountsPage'

function account(patch: Partial<JajaAccountView> = {}): JajaAccountView {
  return {
    accountId: 'test-account-1',
    site: 'MUSINSA',
    label: '테스트 계정 A',
    usernameHint: 'te***',
    syncSupported: true,
    busy: false,
    lastCheckedAt: '2026-09-23T01:00:00Z',
    message: '',
    autoLogin: false,
    browserIdentityState: 'verified',
    session: {
      sessionId: 'session-test-1',
      accountId: 'test-account-1',
      site: 'MUSINSA',
      hostId: 'host-test',
      state: 'observe',
      revision: 1,
      identityState: 'verified',
      providerSessionId: null,
      syncSupported: true
    },
    ...patch
  }
}
function snapshot(accounts: JajaAccountView[] = [account()]): JajaStatus {
  return {
    connected: true,
    connecting: false,
    backendOrigin: 'http://localhost:8000',
    hostId: 'test-host',
    accounts,
    error: null
  }
}

describe('자자 소싱 계정 작업대', () => {
  let root: Root
  let container: HTMLDivElement
  let current: JajaStatus
  let listener: (status: JajaStatus) => void
  const unsubscribe = vi.fn()
  let api: {
    status: ReturnType<typeof vi.fn>
    connect: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
    refresh: ReturnType<typeof vi.fn>
    open: ReturnType<typeof vi.fn>
    check: ReturnType<typeof vi.fn>
    activate: ReturnType<typeof vi.fn>
    pause: ReturnType<typeof vi.fn>
    release: ReturnType<typeof vi.fn>
    onChanged: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.clearAllMocks()
    current = snapshot()
    const result = async (): Promise<{ ok: true; data: JajaStatus }> => ({
      ok: true,
      data: current
    })
    api = {
      status: vi.fn(result),
      connect: vi.fn(async () => ({ ok: true, data: undefined })),
      disconnect: vi.fn(result),
      refresh: vi.fn(result),
      open: vi.fn(async () => ({ ok: true, data: undefined })),
      check: vi.fn(result),
      activate: vi.fn(result),
      pause: vi.fn(result),
      release: vi.fn(result),
      onChanged: vi.fn((callback: (status: JajaStatus) => void) => {
        listener = callback
        return unsubscribe
      })
    }
    window.samba = { jaja: api } as unknown as Window['samba']
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('clearly labels the isolated validation server and synthetic account actions', async () => {
    current = { ...snapshot([]), validation: true, connected: false }
    await act(async () => root.render(createElement(JajaAccountsPage)))
    expect(container.textContent).toContain('검증 전용 · 운영 미연결')
    expect(container.textContent).toContain('검증 데이터에만 적용')
    await act(async () =>
      fireEvent.click(getByRole(container, 'button', { name: '검증 서버 연결' }))
    )
    expect(api.connect).toHaveBeenCalledWith(undefined)
  })
  const mount = async (): Promise<void> => {
    await act(async () => root.render(createElement(JajaAccountsPage)))
  }
  const click = async (element: Element): Promise<void> => {
    await act(async () => fireEvent.click(element))
  }

  it('비교 모드의 동기화 전환은 계정과 공급 전환 내용을 확인한 뒤에만 실행한다', async () => {
    await mount()
    await click(getByRole(container, 'button', { name: '동기화로 전환' }))
    let dialog = getByRole(document.body, 'dialog')
    expect(dialog.textContent).toContain('테스트 계정 A')
    expect(dialog.textContent).toContain('기존 확장앱에서 이 브라우저로 전환')
    expect(api.activate).not.toHaveBeenCalled()
    await click(within(dialog).getByRole('button', { name: '취소' }))
    expect(api.activate).not.toHaveBeenCalled()
    await click(getByRole(container, 'button', { name: '동기화로 전환' }))
    dialog = getByRole(document.body, 'dialog')
    await click(within(dialog).getByRole('button', { name: '확인하고 동기화 시작' }))
    expect(api.activate).toHaveBeenCalledExactlyOnceWith('test-account-1')
  })

  it('연결됨 표시만으로 미검증 또는 미지원 계정을 동기화할 수 없다', async () => {
    const normal = account()
    current.accounts = [
      account({
        label: '미확인 계정',
        browserIdentityState: 'unknown',
        session: { ...normal.session!, identityState: 'unknown' }
      }),
      account({
        accountId: 'test-account-2',
        label: '미지원 계정',
        syncSupported: false,
        syncBlockedReason: 'page_only'
      })
    ]
    await mount()
    const actions = getAllByRole(container, 'button', { name: '동기화로 전환' })
    expect(actions.every((button) => (button as HTMLButtonElement).disabled)).toBe(true)
    expect(container.textContent).toContain('자자 연결됨')
    expect(container.textContent).toContain('로그인 확인 필요')
    expect(container.textContent).toContain('브라우저에서 직접 확인하는 방식')
    expect(api.activate).not.toHaveBeenCalled()
  })

  it('확인 화면을 연 뒤 계정 확인이 취소되면 실행 버튼도 막는다', async () => {
    await mount()
    await click(getByRole(container, 'button', { name: '동기화로 전환' }))
    current.accounts[0].session!.identityState = 'mismatch'
    await act(async () => listener({ ...current, accounts: [...current.accounts] }))
    const button = within(getByRole(document.body, 'dialog')).getByRole('button', {
      name: '확인하고 동기화 시작'
    }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    await click(button)
    expect(api.activate).not.toHaveBeenCalled()
  })

  it('일시중지와 기존 공급 방식 복귀는 서로 다른 API 를 사용한다', async () => {
    current.accounts[0].session!.state = 'active'
    await mount()
    await click(getByRole(container, 'button', { name: '일시중지' }))
    expect(api.pause).toHaveBeenCalledExactlyOnceWith('test-account-1')
    expect(api.release).not.toHaveBeenCalled()
    await click(getByRole(container, 'button', { name: '기존 방식으로 전환' }))
    const dialog = getByRole(document.body, 'dialog')
    expect(dialog.textContent).toContain('기존 발주 PC가 실행 중')
    await click(within(dialog).getByRole('button', { name: '기존 방식으로 전환' }))
    expect(api.release).toHaveBeenCalledExactlyOnceWith('test-account-1')
  })

  it('서버의 이전 확인 기록이 있어도 브라우저 로그인이 만료되면 다시 동기화할 수 없다', async () => {
    current.accounts[0].browserIdentityState = 'expired'
    current.accounts[0].browserIdentityReason = 'login_expired'
    current.accounts[0].message = 'connection_failed'
    await mount()
    expect(container.textContent).toContain('재로그인 필요')
    expect(container.textContent).not.toContain('로그인 계정 확인됨')
    expect(container.textContent).toContain('로그인이 만료되었습니다')
    expect(container.textContent).toContain('자자 서버에 연결하지 못했습니다')
    expect(
      (getByRole(container, 'button', { name: '동기화로 전환' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('서버 오류 원문이나 HTML 을 표시하지 않고 로그인 공간을 명시적으로 연다', async () => {
    await mount()
    api.check.mockResolvedValueOnce({ ok: false, error: '<script>SECRET_COOKIE=example</script>' })
    await click(getByRole(container, 'button', { name: '상태 확인' }))
    expect(getByRole(container, 'alert').textContent).toContain('로그인 상태를 확인하지 못했습니다')
    expect(document.body.textContent).not.toContain('SECRET_COOKIE')
    await click(getByRole(container, 'button', { name: '로그인 공간 열기' }))
    expect(api.open).toHaveBeenCalledExactlyOnceWith('test-account-1')
    expect(ui.setView).toHaveBeenCalledWith('browser')
  })

  it('검색과 소싱처 필터는 표시할 계정만 줄이고 공급 상태를 바꾸지 않는다', async () => {
    current.accounts.push(
      account({ accountId: 'test-account-2', label: '테스트 계정 B', site: 'LOTTEON' })
    )
    await mount()
    await act(async () =>
      fireEvent.change(getByRole(container, 'combobox', { name: '소싱처 필터' }), {
        target: { value: 'LOTTEON' }
      })
    )
    expect(queryByRole(container, 'article', { name: '무신사 테스트 계정 A' })).toBeNull()
    expect(getByRole(container, 'article', { name: '롯데ON 테스트 계정 B' })).toBeTruthy()
    await act(async () =>
      fireEvent.change(getByRole(container, 'textbox', { name: '소싱 계정 검색' }), {
        target: { value: '없음' }
      })
    )
    expect(container.textContent).toContain('검색 조건에 맞는 계정이 없습니다')
    expect(api.activate).not.toHaveBeenCalled()
  })
})
