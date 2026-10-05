import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  reportCardSchedule,
  type CardScheduleReport
} from '../src/main/finance/card-schedule-report'

const mocks = vi.hoisted(() => ({ ssh: vi.fn(), stat: vi.fn(), readFile: vi.fn() }))
vi.mock('node:fs/promises', () => ({ stat: mocks.stat, readFile: mocks.readFile }))
vi.mock('../src/main/finance/card-save-ssh', () => ({ saveCardCollectionOverSsh: mocks.ssh }))

const TOKEN = 'a'.repeat(64)
const REPORT: CardScheduleReport = {
  enabled: true,
  hourKst: 9,
  phase: 'completed',
  runDate: '2026-10-05',
  startedAt: '2026-10-05T09:00:00+09:00',
  finishedAt: '2026-10-05T09:01:00+09:00',
  gapDays: 0,
  results: [
    {
      issuer: 'lotte_card',
      state: 'saved',
      approvalComplete: true,
      complete: false,
      insertedRows: 1,
      updatedRows: 2
    }
  ]
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.ssh.mockResolvedValue({ ok: true })
  mocks.stat.mockResolvedValue({ isFile: () => true, size: TOKEN.length })
  mocks.readFile.mockResolvedValue(TOKEN)
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected live request')))
})
afterEach(() => vi.unstubAllGlobals())

describe('bounded schedule metadata reporting', () => {
  it('sends only fixed metadata through the schedule-report command', async () => {
    await expect(reportCardSchedule(REPORT, { transport: 'server-ssh' })).resolves.toBe(true)
    expect(mocks.ssh).toHaveBeenCalledWith(JSON.stringify(REPORT), undefined, 'schedule-report')
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  it.each([
    { password: 'PRIVATE_SECRET' },
    { rows: ['PRIVATE_ROWS'] },
    { phase: 'PRIVATE_PHASE' },
    { hourKst: 24 },
    { hourKst: 9.5 },
    { enabled: 'true' },
    { results: [{ issuer: 'lotte_card', state: 'failed', reason: 'PRIVATE_REASON' }] },
    { results: [{ issuer: 'lotte_card', state: 'saved', amount: 10000 }] },
    { results: [{ issuer: 'unknown', state: 'saved' }] },
    { results: [{ issuer: 'lotte_card', state: 'running' }] },
    { results: [{ issuer: 'lotte_card', state: 'saved', updatedRows: 10001 }] }
  ])('rejects unbound fields and invalid enum/count values before transport %j', async (change) => {
    await expect(
      reportCardSchedule({ ...REPORT, ...change } as unknown as CardScheduleReport, {
        transport: 'server-ssh'
      })
    ).resolves.toBe(false)
    expect(mocks.ssh).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([{ ok: false }, { ok: true, secret: 'PRIVATE_SECRET' }, { ok: 'true' }, 'PRIVATE_ERROR'])(
    'does not accept or expose an unexpected SSH reply %j',
    async (reply) => {
      mocks.ssh.mockResolvedValue(reply)
      await expect(reportCardSchedule(REPORT, { transport: 'server-ssh' })).resolves.toBe(false)
    }
  )

  it('does not start a report after cancellation or with disabled transport', async () => {
    await expect(
      reportCardSchedule(REPORT, { transport: 'server-ssh', signal: AbortSignal.abort() })
    ).resolves.toBe(false)
    await expect(reportCardSchedule(REPORT, { transport: 'disabled' })).resolves.toBe(false)
    expect(mocks.ssh).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps local credentials in the header of one fixed no-redirect URL', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{"ok":true}'))
    await expect(
      reportCardSchedule(REPORT, { transport: 'local', tokenFile: 'synthetic-token' })
    ).resolves.toBe(true)
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/imports/browser-card/schedule-report',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        body: JSON.stringify(REPORT),
        headers: { 'Content-Type': 'application/json', 'X-Finance-Collector-Token': TOKEN }
      })
    )
    expect(JSON.stringify(REPORT)).not.toContain(TOKEN)
    expect(mocks.ssh).not.toHaveBeenCalled()
  })

  it('rejects local redirects and private credential/transport failures', async () => {
    const options = { transport: 'local', tokenFile: 'synthetic-token' }
    vi.mocked(fetch).mockResolvedValue(new Response('PRIVATE_REDIRECT', { status: 302 }))
    await expect(reportCardSchedule(REPORT, options)).resolves.toBe(false)
    vi.mocked(fetch).mockClear()
    mocks.readFile.mockResolvedValue('PRIVATE_BAD_TOKEN')
    await expect(reportCardSchedule(REPORT, options)).resolves.toBe(false)
    expect(fetch).not.toHaveBeenCalled()
    mocks.ssh.mockRejectedValue(new Error('PRIVATE_SSH_ERROR'))
    await expect(reportCardSchedule(REPORT, { transport: 'server-ssh' })).resolves.toBe(false)
  })
})
