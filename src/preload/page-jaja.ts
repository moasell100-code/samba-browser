import type { IpcRenderer } from 'electron'

// 값 import는 page preload의 sandbox 번들을 깨뜨리므로 채널은 여기에서만 복제한다.
// 실제 권한 검사는 main에서 페어링 탭·최상위 프레임·정확한 origin으로 다시 수행한다.
export function installJajaConnection(ipc: Pick<IpcRenderer, 'invoke'>): void {
  const allowed =
    location.origin === 'https://app.ja-ja.org' || location.origin === 'http://localhost:3000'
  if (!allowed || !location.pathname.startsWith('/samba') || window.self !== window.top) return
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let accepting = false

  const announce = async (): Promise<void> => {
    try {
      const reply = await ipc.invoke('jaja:pairStatus')
      if (closed || !reply?.ok || !reply.data?.pending) return
      accepting = true
      window.postMessage(
        { source: 'samba-extension', type: 'DEVICE_ID', deviceId: reply.data.hostId },
        location.origin
      )
      window.postMessage(
        { source: 'samba-extension', type: 'API_KEY_STATUS', hasKey: false },
        location.origin
      )
      timer = setTimeout(() => void announce(), 3000)
    } catch {
      /* 이 탭은 연결용 탭이 아님 */
    }
  }

  window.addEventListener('message', (event: MessageEvent) => {
    if (!accepting || event.source !== window || event.origin !== location.origin) return
    const value = event.data
    if (!value || value.source !== 'samba-page' || value.type !== 'SAMBA_SET_API_KEY') return
    if (typeof value.apiKey !== 'string' || !/^[a-f0-9]{64}$/i.test(value.apiKey)) return
    accepting = false
    if (timer) clearTimeout(timer)
    void ipc.invoke('jaja:pairKey', value.apiKey).catch(() => {
      /* main에서 상태로 표시 */
    })
  })
  window.addEventListener(
    'pagehide',
    () => {
      closed = true
      if (timer) clearTimeout(timer)
    },
    { once: true }
  )
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', () => void announce(), { once: true })
  else void announce()
}
