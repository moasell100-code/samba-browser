import type { LotteKeypadBridge } from './lotte-keypad-login'
import { isLotteOrigin } from './lotte-login'

interface Deps {
  bridge: Pick<LotteKeypadBridge, 'url' | 'read' | 'focusPassword'>
  tick: () => string | null
  sleep?: (ms: number) => Promise<void>
}
type Result =
  | 'already_open'
  | 'opened'
  | 'remained_closed'
  | 'unsupported'
  | 'nonempty'
  | 'not_ready'
  | 'focus_rejected'
  | 'state_changed'

// No keys, toggle click, clear, submit, Vault or attempt-store capability is available here.
export async function probeLotteKeypadFocus(deps: Deps): Promise<Result> {
  const { bridge } = deps
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const read = async (): ReturnType<LotteKeypadBridge['read']> => {
    const url = bridge.url()
    if (!isLotteOrigin(url) || deps.tick()) throw new Error('stopped')
    const state = await bridge.read()
    if (bridge.url() !== url || deps.tick()) throw new Error('stopped')
    return state
  }
  try {
    if (!isLotteOrigin(bridge.url())) return 'unsupported'
    let state = await read()
    if (!['open', 'closed'].includes(state.state)) return 'not_ready'
    if (state.filled !== 0) return 'nonempty'
    if (state.state === 'open') return 'already_open'
    if (!(await bridge.focusPassword())) return 'focus_rejected'
    for (let poll = 0; poll < 20; poll++) {
      await sleep(100)
      state = await read()
      if (state.state === 'open' && state.filled === 0) return 'opened'
      if (!['closed', 'unknown'].includes(state.state)) return 'state_changed'
      if (state.state === 'closed' && state.filled !== 0) return 'state_changed'
    }
    return state.state === 'closed' ? 'remained_closed' : 'not_ready'
  } catch {
    return 'state_changed'
  }
}
