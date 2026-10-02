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

const listRow = z
  .object({
    head: z
      .array(
        z
          .object({
            field: z.enum([
              'name',
              'date',
              'sales_date',
              'time',
              'card',
              'payment_type',
              'cancellation_status',
              'amount',
              'secondary_amount'
            ]),
            text: z.string().max(2000)
          })
          .strict()
      )
      .min(5)
      .max(7),
    details: z
      .array(
        z
          .object({
            label: z.string().max(2000),
            value: z.string().max(2000)
          })
          .strict()
      )
      .max(17),
    detailsVisible: z.boolean(),
    sourceRowId: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,80}$/)
      .optional()
  })
  .strict()
  .refine(
    (row) =>
      !row.sourceRowId ||
      (!/^-+$/.test(row.sourceRowId) &&
        row.details.filter(({ label, value }) => label === '승인번호' && value === row.sourceRowId)
          .length === 1)
  )

const list = z
  .object({
    adapter: z.enum([
      'samsung_history_list_v1',
      'samsung_cancellation_list_v1',
      'samsung_refund_list_v1',
      'hyundai_history_list_v1',
      'lotte_history_list_v1'
    ]),
    rows: z.array(listRow).max(1000),
    hiddenRows: z.number().int().nonnegative(),
    unrecognizedRows: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    displayedTotal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    unrecognizedDiagnostics: z
      .array(
        z
          .object({
            rowIndex: z.number().int().min(0).max(999),
            reason: z.enum(['link_count', 'field_count', 'empty_fields', 'unsupported_variant']),
            linkCount: z.number().int().min(0).max(1000),
            nameCount: z.number().int().min(0).max(1000).optional(),
            metadataCount: z.number().int().min(0).max(1000).optional(),
            amountCount: z.number().int().min(0).max(1000).optional(),
            emptyFields: z
              .array(
                z.enum([
                  'name',
                  'card',
                  'date',
                  'time',
                  'payment_type',
                  'amount',
                  'cancellation_status',
                  'secondary_amount'
                ])
              )
              .min(1)
              .max(7)
              .optional()
          })
          .strict()
      )
      .max(5)
      .optional()
  })
  .strict()
  .refine(
    (list) =>
      !list.unrecognizedDiagnostics?.length ||
      (['hyundai_history_list_v1', 'lotte_history_list_v1'].includes(list.adapter) &&
        list.unrecognizedDiagnostics.length <= list.unrecognizedRows)
  )
  .refine((list) =>
    list.rows.every((row) =>
      list.adapter === 'lotte_history_list_v1'
        ? (() => {
            const order = row.head.map((cell) => cell.field).join(',')
            if (order === 'name,date,card,payment_type,amount') return true
            const status = row.head.find((cell) => cell.field === 'cancellation_status')?.text
            return (
              (order === 'name,date,card,payment_type,cancellation_status,amount' &&
                status === '취소') ||
              (order ===
                'name,date,card,payment_type,cancellation_status,amount,secondary_amount' &&
                (status === '부분취소' ||
                  /^부분취소\(-(?:\d+|\d{1,3}(?:,\d{3})+)원\)$/.test(status ?? '')))
            )
          })()
        : row.head.map((cell) => cell.field).join(',') ===
          {
            samsung_history_list_v1: 'name,date,time,card,payment_type,amount',
            samsung_cancellation_list_v1: 'name,date,card,cancellation_status,amount',
            samsung_refund_list_v1: 'name,sales_date,card,payment_type,cancellation_status,amount',
            hyundai_history_list_v1: 'name,card,date,time,payment_type,amount',
            lotte_history_list_v1: 'name,date,card,payment_type,amount'
          }[list.adapter]
    )
  )

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
    lists: z.array(list).max(2).optional(),
    layoutDiagnostic: layoutDiagnostic.optional()
  })
  .strict()
  .refine(
    (frame) =>
      !frame.layoutDiagnostic ||
      (financeCardIssuer(frame.origin) === 'hyundai_card' &&
        frame.pathname === '/cpa/cb/CPACB0101_01.hc' &&
        frame.tables.length === 0 &&
        !frame.lists?.length)
  )
  .refine(
    (frame) =>
      !frame.lists?.length ||
      frame.lists.every((list) =>
        list.adapter === 'hyundai_history_list_v1'
          ? financeCardIssuer(frame.origin) === 'hyundai_card' &&
            frame.pathname === '/cpa/cb/CPACB0101_01.hc'
          : list.adapter === 'lotte_history_list_v1'
            ? financeCardIssuer(frame.origin) === 'lotte_card' &&
              frame.pathname === '/app/LPMCDAA_V100.lc'
            : financeCardIssuer(frame.origin) === 'samsung_card' &&
              (frame.pathname === '/personal/card/activity/UHPPRP0801M0.jsp' ||
                frame.pathname ===
                  {
                    samsung_history_list_v1: '/personal/card/activity/UHPPRP0801D0.jsp',
                    samsung_cancellation_list_v1: '/personal/card/activity/UHPPRP0801D8.jsp',
                    samsung_refund_list_v1: '/personal/card/activity/UHPPRP0801DF.jsp'
                  }[list.adapter])
      )
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
