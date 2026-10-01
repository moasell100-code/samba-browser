export type LotteKeypadMode = 'lower' | 'upper' | 'special'
export type LotteKeypadReason =
  | 'auth_unverified'
  | 'field_unverified'
  | 'opener_unverified'
  | 'invalid_buffer'
  | 'root_unverified'
  | 'visible_group_ambiguous'
  | 'mode_ambiguous'
  | 'label_mismatch'
  | 'duplicate_delete'
  | 'duplicate_character'
  | 'duplicate_mode_control'
  | 'unknown_label'
  | 'empty_layout'
export interface LotteKeypadSnapshot {
  state: 'open' | 'closed' | 'signed_in' | 'input_error' | 'unknown' | 'unsupported'
  filled?: number
  reason?: LotteKeypadReason
  layout?: number
  openId?: number
  removeId?: number
  mode?: LotteKeypadMode
  keys?: Array<{ character: string; id: number; label?: string }>
  controls?: Array<{ mode: LotteKeypadMode; id: number }>
}
