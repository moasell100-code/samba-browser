import type { JajaAccount, JajaCookieResult, JajaSession, JajaSignal } from '../../shared/jaja'
import { backendOrigin } from './store'

export class JajaApiError extends Error {
  constructor(public status: number) {
    super(
      status === 401 || status === 403
        ? '자자 연결 권한을 확인하세요. 필요한 경우 다시 연결하세요.'
        : status === 404
          ? '서버에서 브라우저 연결 기능 또는 계정을 찾을 수 없습니다.'
          : status === 409
            ? '서버 상태가 변경됐습니다. 최신 상태를 불러온 뒤 다시 진행하세요.'
            : `자자 서버 요청 실패 (${status})`
    )
  }
}

export class JajaClient {
  constructor(
    private origin: string,
    private hostId: string,
    private key: () => string | null,
    private fetcher: typeof fetch = fetch
  ) {
    this.origin = backendOrigin(origin)
  }

  private async request<T>(path: string, body?: unknown): Promise<T> {
    const key = this.key()
    if (!key) throw new Error('자자 연결이 필요합니다.')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      const response = await this.fetcher(`${this.origin}/api/v1/samba/browser${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'X-Api-Key': key,
          'X-Device-Id': this.hostId,
          'X-Jaja-Browser-Version': '1',
          'Content-Type': 'application/json'
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal
      })
      // 사이트 오류 응답에 비밀값이 있어도 UI나 로그로 전달하지 않는다.
      if (!response.ok) throw new JajaApiError(response.status)
      return (await response.json()) as T
    } catch (error) {
      if (error instanceof JajaApiError) throw error
      throw new Error('자자 서버에 연결하지 못했습니다. 로그인 만료로 판정하지 않았습니다.')
    } finally {
      clearTimeout(timer)
    }
  }

  accounts(): Promise<{ hostId: string; accounts: JajaAccount[] }> {
    return this.request('/accounts')
  }
  sessions(): Promise<{ sessions: JajaSession[] }> {
    return this.request('/sessions')
  }
  register(accountId: string, sessionId: string): Promise<JajaSession> {
    return this.request('/sessions', { accountId, sessionId })
  }
  session(id: string): Promise<JajaSession> {
    return this.request(`/sessions/${encodeURIComponent(id)}`)
  }
  activate(session: JajaSession): Promise<JajaSession> {
    return this.request(`/sessions/${encodeURIComponent(session.sessionId)}/activate`, {
      expectedPreviousOwner: session.providerSessionId,
      revision: session.revision
    })
  }
  pause(session: JajaSession): Promise<JajaSession> {
    return this.request(`/sessions/${encodeURIComponent(session.sessionId)}/pause`, {
      revision: session.revision
    })
  }
  release(session: JajaSession): Promise<JajaSession> {
    return this.request(`/sessions/${encodeURIComponent(session.sessionId)}/release`, {
      revision: session.revision
    })
  }
  cookies(
    session: JajaSession,
    cookie: string,
    extra: Record<string, unknown>
  ): Promise<JajaCookieResult> {
    return this.request(`/sessions/${encodeURIComponent(session.sessionId)}/cookies`, {
      cookie,
      extra,
      mode: session.state === 'active' ? 'sync' : 'observe',
      revision: session.revision
    })
  }
  signals(): Promise<{ signals: JajaSignal[] }> {
    return this.request('/signals')
  }
}
