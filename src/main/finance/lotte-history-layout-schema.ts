import { z } from 'zod'

const node = z
  .object({
    depth: z.number().int().min(0).max(6),
    tag: z.enum([
      'ul',
      'ol',
      'li',
      'div',
      'span',
      'strong',
      'em',
      'b',
      'i',
      'small',
      'p',
      'a',
      'dl',
      'dt',
      'dd',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'br',
      'button'
    ]),
    classes: z
      .array(
        z.enum([
          'useCardList',
          'type02',
          'info',
          'toggle',
          'toggleON',
          'icoMore',
          'useList',
          'cancel',
          'parttot',
          'totLine2',
          'totLine3',
          'off',
          'btns',
          'linkArr',
          'part',
          'partcancel'
        ])
      )
      .max(16),
    id: z.enum(['useCardList', 'aprUseSumList']).optional(),
    omittedClasses: z.boolean(),
    hasUnlistedId: z.boolean(),
    visibleChildCount: z.number().int().min(0).max(1000),
    textKind: z.enum(['empty', 'date_like', 'amount_like', 'nonempty', 'fixed_label']).optional(),
    label: z
      .enum([
        '승인일자',
        '승인번호',
        '이용일자',
        '이용금액',
        '가맹점명',
        '카드번호',
        '카드명',
        '취소일자',
        '취소금액',
        '취소여부',
        '결제일',
        '이용구분',
        '할부개월',
        '승인상태',
        '이용내역',
        '승인금액',
        '결제방법',
        '승인일시',
        '취소일시',
        '매입일자',
        '이용일시',
        '거래유형',
        '포인트사용',
        '매입여부',
        '매입금액',
        '취소',
        '부분취소',
        '승인취소',
        '더보기'
      ])
      .optional()
  })
  .strict()

export const lotteHistoryLayoutSchema = z
  .object({
    state: z.enum(['ok', 'unsupported', 'root_missing', 'root_ambiguous', 'unavailable']),
    directRowCount: z.number().int().min(0).max(1000).optional(),
    root: node.optional(),
    representative: z.array(node).max(80).optional(),
    variantSamples: z
      .array(
        z
          .object({
            variant: z.enum(['normal', 'row_cancel', 'em_cancel', 'em_parttot']),
            rowIndex: z.number().int().min(0).max(999),
            nodes: z.array(node).max(80),
            truncated: z.boolean()
          })
          .strict()
      )
      .max(3)
      .optional(),
    variants: z
      .object({
        cancel: z.number().int().min(0).max(1000),
        parttot: z.number().int().min(0).max(1000),
        toggle: z.number().int().min(0).max(1000),
        toggleON: z.number().int().min(0).max(1000)
      })
      .strict()
      .optional(),
    moreControls: z
      .array(
        z.object({ path: z.array(z.number().int().min(1).max(1000)).min(1).max(6), node }).strict()
      )
      .max(3)
      .optional(),
    truncated: z.boolean().optional()
  })
  .strict()

export function isLotteHistoryLayoutUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.origin === 'https://www.lottecard.co.kr' &&
      !url.username &&
      !url.password &&
      url.pathname === '/app/LPMCDAA_V100.lc'
    )
  } catch {
    return false
  }
}
