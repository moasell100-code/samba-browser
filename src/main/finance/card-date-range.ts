import type { CardDateRange } from './card-api-types'

const DAY_MS = 86_400_000

export function isCardDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** Korea calendar dates, including today; independent of the server PC's timezone. */
export function recentCardDateRange(now: Date = new Date()): CardDateRange {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid collection date')
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now)
  const part = (name: string): string => parts.find((entry) => entry.type === name)!.value
  const to = `${part('year')}-${part('month')}-${part('day')}`
  const from = new Date(new Date(`${to}T00:00:00Z`).getTime() - 3 * DAY_MS)
    .toISOString()
    .slice(0, 10)
  return { from, to }
}

/** Rolling calendar months, clamped to the ledger start; never a monthly full-history sweep. */
export function cancellationCardDateRange(now: Date = new Date()): CardDateRange {
  const to = recentCardDateRange(now).to
  if (to < '2026-07-01') throw new Error('Cancellation date precedes ledger start')
  const today = new Date(`${to}T00:00:00Z`)
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 3, 1))
  const lastDay = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)
  ).getUTCDate()
  first.setUTCDate(Math.min(today.getUTCDate(), lastDay))
  return {
    from:
      first.toISOString().slice(0, 10) < '2026-07-01'
        ? '2026-07-01'
        : first.toISOString().slice(0, 10),
    to
  }
}

export function cancellationCardRanges(range: CardDateRange): CardDateRange[] {
  if (!isCardDate(range.from) || !isCardDate(range.to))
    throw new Error('Invalid cancellation range')
  const from = Date.parse(range.from)
  const to = Date.parse(range.to)
  if (to < from || to - from > 93 * DAY_MS)
    throw new Error('Cancellation range exceeds three months')
  const ranges: CardDateRange[] = []
  for (let day = from; day <= to; day += 4 * DAY_MS)
    ranges.push({
      from: new Date(day).toISOString().slice(0, 10),
      to: new Date(Math.min(day + 3 * DAY_MS, to)).toISOString().slice(0, 10)
    })
  return ranges
}

/** Bound collection to the approved four dates; daily queries avoid large aggregate responses. */
export function dailyCardRanges(range: CardDateRange): CardDateRange[] {
  if (!isCardDate(range.from) || !isCardDate(range.to)) throw new Error('Invalid collection range')
  const from = new Date(`${range.from}T00:00:00Z`).getTime()
  const to = new Date(`${range.to}T00:00:00Z`).getTime()
  if (to < from || to - from > 3 * DAY_MS) throw new Error('Collection range exceeds four days')
  const days: CardDateRange[] = []
  for (let day = from; day <= to; day += DAY_MS) {
    const date = new Date(day).toISOString().slice(0, 10)
    days.push({ from: date, to: date })
  }
  return days
}
