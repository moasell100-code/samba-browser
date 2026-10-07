// Search terms and match counts stay inside the desktop app; no page content is sent.
export const PAGE_FIND_MAX_QUERY = 512

export interface PageFindRequest {
  tabId: string
  sessionId: number
  query: string
  forward: boolean
  next: boolean
}

export type PageFindEvent =
  | { type: 'opened'; tabId: string; sessionId: number; query: string }
  | { type: 'closed'; tabId: string; sessionId: number }
  | {
      type: 'result'
      tabId: string
      sessionId: number
      query: string
      activeMatchOrdinal: number
      matches: number
      finalUpdate: boolean
    }
