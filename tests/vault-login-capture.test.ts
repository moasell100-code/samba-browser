process.env.VAULT_KDF_MEM = '8192'

import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { VaultService } from '../src/main/vault/service'
import { VaultCaptureGate, saveCapturedLoginPassword } from '../src/main/ipc/vault-capture'
import { watchLoginSuccess } from '../src/main/ipc/login-watch'
import { DEFAULT_SETTINGS } from '../src/shared/settings'

const PIN = '012345'
const CAPTURE = { host: 'www.hyundaicard.com', username: 'alice', password: '654321' }
const FRAME = { trusted: true, frameUrl: 'https://www.hyundaicard.com/login' }

class LoginWebContents extends EventEmitter {
  url = FRAME.frameUrl
  isDestroyed(): boolean {
    return false
  }
  getURL(): string {
    return this.url
  }
  async executeJavaScriptInIsolatedWorld(): Promise<{ text: string }> {
    return { text: '로그아웃' }
  }
  succeed(): void {
    this.url = 'https://www.hyundaicard.com/myaccount'
    this.emit('did-navigate')
  }
}

describe('captured passwords preserve PIN login credentials', () => {
  let db: Db
  let vault: VaultService
  let accountId: number

  beforeEach(async () => {
    db = await openDatabase(':memory:')
    vault = new VaultService(db, { get: () => ({ ...DEFAULT_SETTINGS }) })
    await vault.setup('master-pw')
    accountId = vault.upsertAccount({
      host: CAPTURE.host,
      username: CAPTURE.username,
      label: 'My card'
    }).id
  })

  afterEach(() => {
    vault.dispose()
    db.close()
    vi.restoreAllMocks()
  })

  function storeLogin(method: 'password' | 'hyundai_pin'): number {
    return vault.putItem({
      accountId,
      type: 'login',
      label: 'My login',
      sections: [
        {
          key: 'main',
          label: 'Login',
          fields: [
            { key: 'login.method', label: 'Login method', kind: 'select', value: method },
            {
              key: 'value',
              label: 'Secret',
              kind: 'secret',
              value: method === 'hyundai_pin' ? PIN : 'old-password'
            }
          ]
        }
      ]
    }).id
  }

  it('refuses a capture accepted while locked after the user unlocks', async () => {
    const itemId = storeLogin('hyundai_pin')
    vault.lock()
    const gate = new VaultCaptureGate({ vault, excludedHosts: () => [] })
    expect(gate.handle({}, FRAME, CAPTURE)).toBe('accepted')
    await vault.unlock('master-pw')
    const capture = vault.takePendingCapture()
    expect(capture).not.toBeNull()
    const upsert = vi.spyOn(vault, 'upsertAccount')
    const put = vi.spyOn(vault, 'putItem')
    expect(saveCapturedLoginPassword(vault, capture!)).toBe(false)
    expect(upsert).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
    expect(vault.reveal(itemId)).toBe(PIN)
  })

  it('rechecks the method when an older password capture is accepted', () => {
    storeLogin('password')
    const gate = new VaultCaptureGate({ vault, excludedHosts: () => [] })
    expect(gate.handle({}, FRAME, CAPTURE)).toBe('accepted')
    const itemId = storeLogin('hyundai_pin')
    expect(saveCapturedLoginPassword(vault, vault.takePendingCapture()!)).toBe(false)
    expect(vault.reveal(itemId)).toBe(PIN)
  })

  it('still saves ordinary passwords and preserves the account label', () => {
    const itemId = storeLogin('password')
    expect(saveCapturedLoginPassword(vault, CAPTURE)).toBe(true)
    expect(vault.reveal(itemId)).toBe(CAPTURE.password)
    expect(vault.getAccount(accountId)?.label).toBe('My card')
  })

  it('does not auto-update if the login method changed while navigation was pending', async () => {
    storeLogin('password')
    const wc = new LoginWebContents()
    const onUpdated = vi.fn()
    const update = vi.spyOn(vault, 'applyAutoPasswordUpdate')
    watchLoginSuccess(
      wc as unknown as WebContents,
      FRAME.frameUrl,
      { ...CAPTURE, accountId },
      vault,
      onUpdated
    )
    const itemId = storeLogin('hyundai_pin')
    wc.succeed()
    await vi.waitFor(() => expect(wc.listenerCount('did-navigate')).toBe(0))
    expect(update).not.toHaveBeenCalled()
    expect(onUpdated).not.toHaveBeenCalled()
    expect(vault.reveal(itemId)).toBe(PIN)
  })

  it('still auto-updates ordinary password logins after successful navigation', async () => {
    const itemId = storeLogin('password')
    const wc = new LoginWebContents()
    const onUpdated = vi.fn()
    watchLoginSuccess(
      wc as unknown as WebContents,
      FRAME.frameUrl,
      { ...CAPTURE, accountId },
      vault,
      onUpdated
    )
    wc.succeed()
    await vi.waitFor(() => expect(onUpdated).toHaveBeenCalledOnce())
    expect(vault.reveal(itemId)).toBe(CAPTURE.password)
    expect(wc.listenerCount('did-navigate')).toBe(0)
  })
})
