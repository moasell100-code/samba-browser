import { z } from 'zod'

export function isFinanceCaptureUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      ['hyundaicard.com', 'www.hyundaicard.com'].includes(url.hostname)
    )
  } catch {
    return false
  }
}

const cell = z
  .object({
    text: z.string().max(2000),
    header: z.boolean(),
    rowSpan: z.number().int().min(0).max(65534),
    colSpan: z.number().int().min(1).max(1000)
  })
  .strict()

export const financeFrameCaptureSchema = z
  .object({
    origin: z.string().refine(isFinanceCaptureUrl),
    pathname: z.string().max(2000).startsWith('/'),
    tables: z
      .array(
        z
          .object({
            index: z.number().int().min(0).max(19),
            rows: z.array(z.array(cell).max(40)).max(1000),
            hiddenRows: z.number().int().nonnegative(),
            hasNestedTable: z.boolean()
          })
          .strict()
      )
      .max(20)
  })
  .strict()

export const financePageCaptureSchema = z
  .object({
    frames: z.array(financeFrameCaptureSchema).min(1).max(21),
    failedFrames: z.number().int().nonnegative(),
    skippedFrames: z.number().int().nonnegative()
  })
  .strict()

/** A vocabulary helper for a future verified adapter; unknown never means approved. */
export function validateApprovalStatus(value: string): 'active' | 'cancelled' | 'unknown' {
  const status = value.trim()
  if (['승인', '승인완료'].includes(status)) return 'active'
  if (['취소', '승인취소', '취소완료'].includes(status)) return 'cancelled'
  return 'unknown'
}
