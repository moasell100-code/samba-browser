export interface CardSessionSnapshot {
  issuer: 'hyundai_card' | 'samsung_card' | 'lotte_card' | null
  state: 'signed_in' | 'signed_out' | 'unknown' | 'unsupported'
}
