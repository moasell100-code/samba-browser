export interface LotteAuthSnapshot {
  state:
    | 'signed_in'
    | 'keyboard_ready'
    | 'keypad_required'
    | 'initializing'
    | 'input_error'
    | 'unknown'
    | 'unsupported'
  focused?: boolean
  filled?: number
}
