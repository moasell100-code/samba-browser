import { describe, expect, it } from 'vitest'
import {
  dailyCardRanges,
  isCardDate,
  recentCardDateRange
} from '../src/main/finance/card-date-range'

describe('four Korean calendar dates including today', () => {
  it('includes today across the Korean midnight and month boundary', () => {
    expect(recentCardDateRange(new Date('2026-10-01T14:59:59Z'))).toEqual({
      from: '2026-09-28',
      to: '2026-10-01'
    })
    expect(recentCardDateRange(new Date('2026-10-01T15:00:00Z'))).toEqual({
      from: '2026-09-29',
      to: '2026-10-02'
    })
  })
  it('handles leap days and produces four adjacent single-day queries', () => {
    const range = recentCardDateRange(new Date('2024-03-01T01:00:00Z'))
    expect(range).toEqual({ from: '2024-02-27', to: '2024-03-01' })
    expect(dailyCardRanges(range).map((day) => day.from)).toEqual([
      '2024-02-27',
      '2024-02-28',
      '2024-02-29',
      '2024-03-01'
    ])
  })
  it('rejects invalid dates, reversed ranges, and implicit historical backfill', () => {
    expect(isCardDate('2026-02-29')).toBe(false)
    expect(() => dailyCardRanges({ from: '2026-09-28', to: '2026-10-02' })).toThrow()
    expect(() => dailyCardRanges({ from: '2026-10-02', to: '2026-10-01' })).toThrow()
    expect(() => recentCardDateRange(new Date(NaN))).toThrow()
  })
})
