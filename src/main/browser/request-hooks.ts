// Electron webRequest 는 이벤트마다 마지막 리스너 하나만 사용한다.
// 헤더 변환과 쿠키 관측이 서로 지워지지 않도록 세션당 한 리스너에서 배분한다.
// 요청·쿠키 값은 로그나 IPC 로 내보내지 않는다.
import type { OnBeforeSendHeadersListenerDetails, Session } from 'electron'

export type SessionRequestDetails = Readonly<
  Omit<OnBeforeSendHeadersListenerDetails, 'requestHeaders'> & {
    requestHeaders: Readonly<Record<string, string>>
  }
>

type HeaderTransform = (details: SessionRequestDetails) => Record<string, string> | void
type RequestObserver = (details: SessionRequestDetails) => void | Promise<void>

interface Registration<T> {
  callback: T
}

interface RequestHooks {
  transforms: Map<string, Registration<HeaderTransform>>
  observers: Map<string, Registration<RequestObserver>>
}

const sessions = new WeakMap<Session, RequestHooks>()

function snapshot(
  details: OnBeforeSendHeadersListenerDetails,
  headers: Record<string, string>
): SessionRequestDetails {
  return Object.freeze({ ...details, requestHeaders: Object.freeze({ ...headers }) })
}

function hooksFor(session: Session): RequestHooks {
  const existing = sessions.get(session)
  if (existing) return existing
  const hooks: RequestHooks = { transforms: new Map(), observers: new Map() }
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    let headers = { ...details.requestHeaders }
    for (const transform of [...hooks.transforms.values()]) {
      try {
        const next = transform.callback(snapshot(details, headers))
        if (next) headers = { ...next }
      } catch {
        // 실패한 변환만 건너뛴다. 예외 메시지에는 인증 헤더가 들어갈 수 있다.
        console.warn('브라우저 요청 헤더 처리 실패')
      }
    }
    const observed = snapshot(details, headers)
    for (const observer of [...hooks.observers.values()]) {
      try {
        // 동기화가 느려도 실제 쇼핑몰 요청은 기다리지 않는다.
        void Promise.resolve(observer.callback(observed)).catch(() => {
          console.warn('브라우저 요청 관측 처리 실패')
        })
      } catch {
        console.warn('브라우저 요청 관측 처리 실패')
      }
    }
    callback({ requestHeaders: headers })
  })
  sessions.set(session, hooks)
  return hooks
}

function register<T>(map: Map<string, Registration<T>>, key: string, callback: T): () => void {
  const registration = { callback }
  map.set(key, registration)
  return () => {
    // 같은 key 로 교체된 새 등록을 오래된 dispose 가 지우면 안 된다.
    if (map.get(key) === registration) map.delete(key)
  }
}

/** 메인 프로세스 전용. 관측자는 헤더를 바꾸거나 요청을 취소할 수 없다. */
export function observeSessionRequests(
  session: Session,
  key: string,
  callback: RequestObserver
): () => void {
  return register(hooksFor(session).observers, key, callback)
}

/** 헤더 변경도 반드시 같은 dispatcher 를 거친다. */
export function transformSessionRequestHeaders(
  session: Session,
  key: string,
  callback: HeaderTransform
): () => void {
  return register(hooksFor(session).transforms, key, callback)
}
