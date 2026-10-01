import { z } from 'zod'
import type { FinanceCardIssuer } from '../../shared/finance-capture'

export function financeCardIssuer(value: string): FinanceCardIssuer | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '')
      return null
    if (['hyundaicard.com', 'www.hyundaicard.com'].includes(url.hostname)) return 'hyundai_card'
    if (url.hostname === 'www.samsungcard.com') return 'samsung_card'
    if (url.hostname === 'www.lottecard.co.kr') return 'lotte_card'
    return null
  } catch {
    return null
  }
}

export function isFinanceCaptureUrl(value: string): boolean {
  return financeCardIssuer(value) !== null
}

const cell = z
  .object({
    text: z.string().max(2000),
    header: z.boolean(),
    rowSpan: z.number().int().min(0).max(65534),
    colSpan: z.number().int().min(1).max(1000)
  })
  .strict()

const layoutDiagnostic = z
  .object({
    nodes: z
      .array(
        z
          .object({
            depth: z.number().int().min(0).max(8),
            tag: z.enum([
              'div',
              'span',
              'ul',
              'ol',
              'li',
              'dl',
              'dt',
              'dd',
              'p',
              'a',
              'strong',
              'em',
              'b',
              'i',
              'small',
              'section',
              'article',
              'header',
              'footer',
              'nav',
              'h1',
              'h2',
              'h3',
              'h4',
              'h5',
              'h6',
              'br',
              'hr',
              'img'
            ]),
            classes: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/)).max(12)
          })
          .strict()
      )
      .min(1)
      .max(80),
    truncated: z.boolean()
  })
  .strict()

export const financeFrameCaptureSchema = z
  .object({
    origin: z
      .string()
      .refine((value) => isFinanceCaptureUrl(value) && new URL(value).origin === value),
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
      .max(20),
    layoutDiagnostic: layoutDiagnostic.optional()
  })
  .strict()
  .refine(
    (frame) =>
      !frame.layoutDiagnostic ||
      (financeCardIssuer(frame.origin) === 'hyundai_card' &&
        frame.pathname === '/cpa/cb/CPACB0101_01.hc' &&
        frame.tables.length === 0)
  )

export const financePageCaptureSchema = z
  .object({
    frames: z.array(financeFrameCaptureSchema).min(1).max(21),
    failedFrames: z.number().int().nonnegative(),
    skippedFrames: z.number().int().nonnegative()
  })
  .strict()
  .refine((page) =>
    page.frames.every(
      (frame) => financeCardIssuer(frame.origin) === financeCardIssuer(page.frames[0].origin)
    )
  )

/** A vocabulary helper for a future verified adapter; unknown never means approved. */
export function validateApprovalStatus(value: string): 'active' | 'cancelled' | 'unknown' {
  const status = value.trim()
  if (['승인', '승인완료'].includes(status)) return 'active'
  if (['취소', '승인취소', '취소완료'].includes(status)) return 'cancelled'
  return 'unknown'
}
