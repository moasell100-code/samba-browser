export type LotteKeypadMode = 'lower' | 'upper' | 'special'
export interface LotteKeypadSnapshot {
  state: 'open' | 'closed' | 'signed_in' | 'input_error' | 'unknown' | 'unsupported'
  filled?: number
  layout?: number
  openId?: number
  removeId?: number
  mode?: LotteKeypadMode
  keys?: Array<{ character: string; id: number }>
  controls?: Array<{ mode: LotteKeypadMode; id: number }>
}
