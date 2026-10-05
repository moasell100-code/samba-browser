import { CARD_NAVIGATION_CODES, type CardNavigationFailure } from '../../shared/card-navigation'

const errnoCodes: Readonly<Record<number, CardNavigationFailure['code']>> = {
  [-2]: 'ERR_FAILED',
  [-3]: 'ERR_ABORTED',
  [-7]: 'ERR_TIMED_OUT',
  [-100]: 'ERR_CONNECTION_CLOSED',
  [-101]: 'ERR_CONNECTION_RESET',
  [-102]: 'ERR_CONNECTION_REFUSED',
  [-103]: 'ERR_CONNECTION_ABORTED',
  [-104]: 'ERR_CONNECTION_FAILED',
  [-105]: 'ERR_NAME_NOT_RESOLVED',
  [-106]: 'ERR_INTERNET_DISCONNECTED',
  [-107]: 'ERR_SSL_PROTOCOL_ERROR',
  [-109]: 'ERR_ADDRESS_UNREACHABLE',
  [-111]: 'ERR_TUNNEL_CONNECTION_FAILED',
  [-118]: 'ERR_CONNECTION_TIMED_OUT',
  [-130]: 'ERR_PROXY_CONNECTION_FAILED',
  [-200]: 'ERR_CERT_COMMON_NAME_INVALID',
  [-201]: 'ERR_CERT_DATE_INVALID',
  [-202]: 'ERR_CERT_AUTHORITY_INVALID'
}
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined
  const property = Object.getOwnPropertyDescriptor(value, key)
  return property && 'value' in property ? property.value : undefined
}
function knownCode(value: unknown): CardNavigationFailure['code'] | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.startsWith('net::') ? value.slice(5) : value
  return (CARD_NAVIGATION_CODES as readonly string[]).includes(normalized)
    ? (normalized as CardNavigationFailure['code'])
    : undefined
}

/** Extract only an allowlisted net code; all unrecognized details remain inside main-process RAM. */
export function classifyCardNavigationFailure(error: unknown): CardNavigationFailure {
  let code = knownCode(own(error, 'code'))
  if (!code) {
    const message = own(error, 'message')
    if (typeof message === 'string') {
      // Electron loadURL messages start with the net code and then may contain a private URL.
      // Never scan arbitrary embedded text or return the remainder of that message.
      const prefix = /^(?:net::)?(ERR_[A-Z_]{1,64})(?=$|[\s(:])/.exec(message.slice(0, 96))
      code = prefix ? knownCode(prefix[1]) : undefined
    }
  }
  if (!code) {
    const errno = own(error, 'errno')
    if (typeof errno === 'number' && Number.isInteger(errno)) code = errnoCodes[errno]
  }
  code ??= 'UNKNOWN'
  const category: CardNavigationFailure['category'] =
    code === 'ERR_ABORTED'
      ? 'aborted'
      : code.includes('PROXY') || code === 'ERR_TUNNEL_CONNECTION_FAILED'
        ? 'proxy'
        : code === 'ERR_INVALID_AUTH_CREDENTIALS' || code === 'ERR_UNSUPPORTED_AUTH_SCHEME'
          ? 'authentication'
          : code.startsWith('ERR_CERT') || code.startsWith('ERR_SSL')
            ? 'tls'
            : code === 'ERR_NAME_NOT_RESOLVED'
              ? 'dns'
              : code === 'ERR_TIMED_OUT' || code === 'ERR_CONNECTION_TIMED_OUT'
                ? 'timeout'
                : code.startsWith('ERR_CONNECTION') ||
                    code === 'ERR_INTERNET_DISCONNECTED' ||
                    code === 'ERR_ADDRESS_UNREACHABLE' ||
                    code === 'ERR_NETWORK_CHANGED'
                  ? 'connection'
                  : code.startsWith('ERR_BLOCKED') ||
                      code === 'ERR_ACCESS_DENIED' ||
                      code === 'ERR_DISALLOWED_URL_SCHEME'
                    ? 'blocked'
                    : 'unknown'
  return { code, category }
}
