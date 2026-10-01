// Only status and visible control IDs cross the page bridge. Never include PIN values.
export interface HyundaiAuthSnapshot {
  state:
    | 'signed_in'
    | 'pin_ready'
    | 'registration_required'
    | 'unsupported'
    | 'additional_auth'
    | 'pin_error'
    | 'unknown'
  inputId?: number
  filled?: number
  digits?: Array<{ digit: string; id: number }>
}
