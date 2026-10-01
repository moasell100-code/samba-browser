import type { LotteKeypadSnapshot } from '../../shared/lotte-keypad'
import { isLotteOrigin } from './lotte-login'

interface ProbeDeps {
  bridge: {
    url: () => string
    read: () => Promise<LotteKeypadSnapshot>
    press: (id: number, count: number, layout: number) => Promise<boolean>
    erase: (layout: number) => Promise<boolean>
  }
  tick: () => string | null
  sleep?: (ms: number) => Promise<void>
}
type ProbeResult =
  | 'accepted_and_cleared'
  | 'unsupported'
  | 'not_ready'
  | 'nonempty'
  | 'input_not_accepted'
  | 'cleanup_not_confirmed'
  | 'state_changed'

// No Vault, account, attempt store or submit capability is passed to this diagnostic.
export async function probeLotteKeypad(deps: ProbeDeps): Promise<ProbeResult> {
  const { bridge } = deps
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const read = async (): Promise<LotteKeypadSnapshot> => {
    const url = bridge.url()
    if (!isLotteOrigin(url) || deps.tick()) throw new Error('stopped')
    const state = await bridge.read()
    if (bridge.url() !== url || deps.tick()) throw new Error('stopped')
    return state
  }
  const press = async (id: number | undefined, state: LotteKeypadSnapshot): Promise<boolean> => {
    if (
      !Number.isInteger(id) ||
      state.filled !== 0 ||
      !Number.isSafeInteger(state.layout) ||
      deps.tick() ||
      !isLotteOrigin(bridge.url())
    )
      return false
    return bridge.press(id!, 0, state.layout!)
  }
  try {
    if (!isLotteOrigin(bridge.url())) return 'unsupported'
    let state = await read()
    if (!['open', 'closed'].includes(state.state)) return 'not_ready'
    if (state.filled !== 0) return 'nonempty'
    if (state.state === 'closed') {
      if (!(await press(state.openId, state))) return 'state_changed'
      for (let poll = 0; poll < 20; poll++) {
        await sleep(100)
        state = await read()
        if (state.state !== 'closed') break
      }
    }
    if (state.state !== 'open' || state.filled !== 0) return 'not_ready'
    if (state.mode !== 'lower') {
      const control = state.controls?.find((candidate) => candidate.mode === 'lower')
      if (!control || !(await press(control.id, state))) return 'not_ready'
      for (let poll = 0; poll < 20; poll++) {
        await sleep(100)
        state = await read()
        if (state.state !== 'open' || state.filled !== 0) return 'state_changed'
        if (state.mode === 'lower') break
      }
    }
    const keys = state.keys?.filter((key) => key.character === 'a') ?? []
    if (state.mode !== 'lower' || keys.length !== 1 || state.removeId === undefined)
      return 'not_ready'
    if (!(await press(keys[0].id, state))) return 'state_changed'
    for (let poll = 0; poll < 20; poll++) {
      await sleep(100)
      state = await read()
      if (state.state !== 'open' || (state.filled !== 0 && state.filled !== 1))
        return 'state_changed'
      if (state.filled === 1) break
    }
    if (state.filled !== 1) return 'input_not_accepted'
    if (
      state.layout === undefined ||
      state.removeId === undefined ||
      !(await bridge.erase(state.layout))
    )
      return 'cleanup_not_confirmed'
    for (let poll = 0; poll < 20; poll++) {
      await sleep(100)
      state = await read()
      if (state.state !== 'open' || (state.filled !== 0 && state.filled !== 1))
        return 'cleanup_not_confirmed'
      if (state.filled === 0) return 'accepted_and_cleared'
    }
    return 'cleanup_not_confirmed'
  } catch {
    return 'state_changed'
  }
}
