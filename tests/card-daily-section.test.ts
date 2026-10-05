// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CardDailySection } from '../src/renderer/src/components/settings/CardDailySection'
import { parseSettings } from '../src/shared/settings'
import type { CardDailyStatus } from '../src/shared/card-daily'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'ko' } })
}))

const status = (patch: Partial<CardDailyStatus> = {}): CardDailyStatus => ({
  enabled: true,
  hourKst: 9,
  phase: 'completed',
  gapDays: 0,
  nextRunAt: null,
  results: [],
  ...patch
})

describe('daily card status UI', () => {
  let host: HTMLDivElement
  let root: Root
  let changed: (value: CardDailyStatus) => void
  let unsubscribe: ReturnType<typeof vi.fn>
  let readStatus: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    unsubscribe = vi.fn()
    readStatus = vi.fn()
    Object.defineProperty(window, 'samba', {
      configurable: true,
      value: {
        cardDaily: {
          status: readStatus,
          onChanged: (handler: (value: CardDailyStatus) => void) => {
            changed = handler
            return unsubscribe
          }
        }
      }
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    vi.restoreAllMocks()
  })

  async function render(): Promise<void> {
    await act(async () => {
      root.render(createElement(CardDailySection, { settings: parseSettings({}), update: vi.fn() }))
    })
  }

  it('distinguishes saved approvals from unverified cancellation coverage', async () => {
    readStatus.mockResolvedValue({
      ok: true,
      data: status({
        results: [{ issuer: 'lotte_card', state: 'saved', approvalComplete: true, complete: false }]
      })
    })
    await render()
    const lotte = Array.from(host.querySelectorAll('li')).find((li) =>
      li.textContent?.includes('롯데카드')
    )!
    expect(lotte.textContent).toContain('cardDaily.approvalsSaved')
    expect(lotte.textContent).toContain('cardDaily.partial')
    expect(lotte.textContent).not.toContain('cardDaily.states.saved')
    await act(async () =>
      changed(
        status({
          results: [
            { issuer: 'lotte_card', state: 'saved', approvalComplete: false, complete: false }
          ]
        })
      )
    )
    expect(lotte.textContent).toContain('cardDaily.approvalsIncomplete')
  })

  it('does not replace a new event with an older initial status response', async () => {
    let resolve!: (value: { ok: true; data: CardDailyStatus }) => void
    readStatus.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    await render()
    await act(async () => changed(status({ phase: 'running' })))
    await act(async () => resolve({ ok: true, data: status({ phase: 'idle' }) }))
    expect(host.textContent).toContain('cardDaily.phases.running')
    expect(host.textContent).not.toContain('cardDaily.phases.idle')
    await act(async () => root.unmount())
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('shows a status error without exposing raw IPC failure details', async () => {
    readStatus.mockResolvedValue({ ok: false, error: 'private backend detail' })
    await render()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('cardDaily.unavailable')
    expect(host.textContent).not.toContain('private backend detail')
  })

  it('keeps a successful primary save distinct from an unsuccessful old-approval recheck', async () => {
    readStatus.mockResolvedValue({
      ok: true,
      data: status({
        results: [
          {
            issuer: 'lotte_card',
            state: 'saved',
            approvalComplete: true,
            complete: false,
            reconciliation: { state: 'failed', checkedDays: 0, reviewRows: 0, updatedRows: 0 }
          }
        ]
      })
    })
    await render()
    const lotte = Array.from(host.querySelectorAll('li')).find((li) =>
      li.textContent?.includes('롯데카드')
    )!
    expect(lotte.textContent).toContain('cardDaily.approvalsSaved')
    expect(lotte.textContent).toContain('cardDaily.reconciliation.failed')
    expect(lotte.textContent).not.toContain('cardDaily.states.failed')
  })
})
