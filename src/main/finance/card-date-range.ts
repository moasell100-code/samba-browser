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
