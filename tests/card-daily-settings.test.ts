import { describe, expect, it } from 'vitest'
import { parseSettings } from '../src/shared/settings'
import { SYNCED_SETTING_KEYS } from '../src/shared/sync'

describe('device-local daily card collection settings', () => {
  it('does not automatically enable existing installations', () => {
    const settings = parseSettings({})
    expect(settings.financeDailyEnabled).toBe(false)
    expect(settings.financeDailyHourKst).toBe(9)
  })

  it.each([0, 9, 23])('accepts KST hour %i', (hour) => {
    const settings = parseSettings({ financeDailyEnabled: true, financeDailyHourKst: hour })
    expect(settings.financeDailyEnabled).toBe(true)
    expect(settings.financeDailyHourKst).toBe(hour)
  })

  it.each([-1, 24, 9.5, '9', null])('rejects invalid hours %s', (hour) => {
    expect(parseSettings({ financeDailyHourKst: hour }).financeDailyHourKst).toBe(9)
  })

  it('invalid enable flags fail closed and schedule settings are never synced to other PCs', () => {
    expect(parseSettings({ financeDailyEnabled: 'true' }).financeDailyEnabled).toBe(false)
    expect(SYNCED_SETTING_KEYS).not.toContain('financeDailyEnabled')
    expect(SYNCED_SETTING_KEYS).not.toContain('financeDailyHourKst')
  })
})
