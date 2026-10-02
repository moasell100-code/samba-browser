/** Bounded public structure only; no transaction text, values, or dynamic identifiers. */
export interface LotteHistoryLayoutNode {
  depth: number
  tag: string
  classes: string[]
  id?: 'useCardList' | 'aprUseSumList'
  omittedClasses: boolean
  hasUnlistedId: boolean
  visibleChildCount: number
  textKind?: 'empty' | 'date_like' | 'amount_like' | 'nonempty' | 'fixed_label'
  label?: string
}

export interface LotteHistoryLayout {
  state: 'ok' | 'unsupported' | 'root_missing' | 'root_ambiguous' | 'unavailable'
  directRowCount?: number
  root?: LotteHistoryLayoutNode
  representative?: LotteHistoryLayoutNode[]
  variants?: { cancel: number; parttot: number; toggle: number; toggleON: number }
  /** One-based child-element indexes from #useCardList.parentElement, no attribute selectors. */
  moreControls?: Array<{ path: number[]; node: LotteHistoryLayoutNode }>
  truncated?: boolean
}
