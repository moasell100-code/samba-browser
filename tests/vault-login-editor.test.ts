// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, getByLabelText, getByRole, queryByRole } from '@testing-library/dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountDto, VaultItemMeta } from '../src/shared/vault'
import ko from '../src/renderer/src/i18n/ko.json'

const state = vi.hoisted(() => ({
  upsertAccount: vi.fn(),
  putItem: vi.fn(),
  select: vi.fn(),
  selectGlobalItem: vi.fn(),
  accounts: [],
  error: null
}))
vi.mock('@renderer/stores/vaultStore', () => ({
  useVaultStore: (select: (value: typeof state) => unknown) => select(state)
}))
vi.mock('@renderer/stores/browserStore', () => ({
  useBrowserStore: (select: (value: unknown) => unknown) => select({ activeTab: null })
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key
        .split('.')
        .reduce((value: unknown, part) => (value as Record<string, unknown>)?.[part], ko) ?? key
  })
}))
import { ItemEditor } from '../src/renderer/src/components/vault/ItemEditor'

function account(host = 'hyundaicard.com'): AccountDto {
  return {
    id: 1,
    siteId: 1,
    host,
    label: '현대카드',
    username: '',
    isDefault: true,
    itemTypes: ['login'],
    urls: [],
    agentAccess: 'inherit',
    tags: []
  }
}

function item(method?: string): VaultItemMeta {
  return {
    id: 3,
    accountId: 1,
    type: 'login',
    label: '현대카드',
    updatedAt: 1,
    sections: [
      {
        key: 'main',
        label: '로그인',
        fields: [
          ...(method
            ? [
                {
                  key: 'login.method',
                  kind: 'select' as const,
                  label: '로그인 방식',
                  value: method
                }
              ]
            : []),
          { key: 'value', kind: 'secret', label: '비밀번호' }
        ]
      }
    ]
  }
}

describe('Hyundai Card login editor', () => {
  let root: Root
  let container: HTMLDivElement
  let close: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.clearAllMocks()
    state.upsertAccount.mockResolvedValue(account())
    state.putItem.mockResolvedValue(true)
    close = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  async function mount(saved?: VaultItemMeta, host?: string): Promise<void> {
    await act(async () =>
      root.render(
        createElement(ItemEditor, {
          open: true,
          onOpenChange: close,
          type: 'login',
          account: account(host),
          item: saved
        })
      )
    )
  }

  async function change(label: string, value: string): Promise<void> {
    await act(async () =>
      fireEvent.change(getByLabelText(document.body, label), { target: { value } })
    )
  }

  async function save(): Promise<void> {
    await act(async () => fireEvent.click(getByRole(document.body, 'button', { name: '저장' })))
  }

  it('saves a PIN as the existing secret field plus public method metadata without requiring username', async () => {
    await mount()
    await change('로그인 방식', 'hyundai_pin')
    const secret = getByLabelText(document.body, '간편번호(6자리)') as HTMLInputElement
    expect(secret.type).toBe('password')
    expect(secret.inputMode).toBe('numeric')
    expect(getByLabelText(document.body, '아이디 (간편번호 로그인에서는 선택)')).toBeTruthy()
    expect(queryByRole(document.body, 'button', { name: '생성' })).toBeNull()
    await change('간편번호(6자리)', '012345')
    await save()
    expect(state.upsertAccount).toHaveBeenCalledWith(expect.objectContaining({ username: '' }))
    expect(state.putItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'login',
        label: '현대카드',
        sections: [
          {
            key: 'main',
            label: ko.vault.sections.login,
            fields: [
              { key: 'login.method', label: '로그인 방식', kind: 'select', value: 'hyundai_pin' },
              { key: 'value', label: '간편번호(6자리)', kind: 'secret', value: '012345' }
            ]
          }
        ]
      })
    )
    expect(document.body.textContent).not.toContain('012345')
    expect(close).toHaveBeenCalledWith(false)
  })

  it.each(['', '12345', '1234567', '12a456', '123456 '])(
    'rejects malformed new PIN %j before account or item writes',
    async (value) => {
      await mount()
      await change('로그인 방식', 'hyundai_pin')
      if (value) await change('간편번호(6자리)', value)
      await save()
      expect(getByRole(document.body, 'alert').textContent).toBe(ko.vault.editor.hyundaiPinInvalid)
      expect(state.upsertAccount).not.toHaveBeenCalled()
      expect(state.putItem).not.toHaveBeenCalled()
    }
  )

  it('keeps an existing PIN secret when the edit is blank', async () => {
    await mount(item('hyundai_pin'))
    await save()
    const saved = state.putItem.mock.calls[0][0]
    expect(
      saved.sections[0].fields.find((field: { key: string }) => field.key === 'value')
    ).toEqual({
      key: 'value',
      label: '간편번호(6자리)',
      kind: 'secret'
    })
  })

  it('requires a replacement secret when switching an existing login method', async () => {
    await mount(item())
    await change('비밀번호', '123456')
    await change('로그인 방식', 'hyundai_pin')
    expect((getByLabelText(document.body, '간편번호(6자리)') as HTMLInputElement).value).toBe('')
    await save()
    expect(state.putItem).not.toHaveBeenCalled()
    expect(getByRole(document.body, 'alert').textContent).toBe(ko.vault.editor.hyundaiPinInvalid)
  })

  it.each(['example.com', 'm.hyundaicard.com', 'hyundaicard.com.evil.test'])(
    'keeps generic password behavior for %s',
    async (host) => {
      await mount(item(), host)
      expect(queryByRole(document.body, 'combobox', { name: '로그인 방식' })).toBeNull()
      expect(getByLabelText(document.body, '비밀번호')).toBeTruthy()
      expect(getByRole(document.body, 'button', { name: '생성' })).toBeTruthy()
      await save()
      expect(state.putItem.mock.calls[0][0].sections[0].fields).toContainEqual({
        key: 'login.method',
        label: '로그인 방식',
        kind: 'select',
        value: 'password'
      })
    }
  )

  it('does not move a selected PIN to an unsupported host', async () => {
    await mount(item('hyundai_pin'))
    await change('사이트 호스트', 'example.com')
    await save()
    expect(getByRole(document.body, 'alert').textContent).toBe(ko.vault.editor.hyundaiPinHost)
    expect(state.upsertAccount).not.toHaveBeenCalled()
    expect(state.putItem).not.toHaveBeenCalled()
  })
})
