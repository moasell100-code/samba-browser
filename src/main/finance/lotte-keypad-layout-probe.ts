import type {
  LotteKeypadSnapshot,
  LotteKeypadMode,
  LotteKeypadReason
} from '../../shared/lotte-keypad'
import type { LotteKeypadBridge } from './lotte-keypad-login'
import { isLotteOrigin } from './lotte-login'

type Stage =
  | 'initial_state'
  | 'open_keypad'
  | 'preflight_lower'
  | 'preflight_upper'
  | 'preflight_special'
  | 'restore_lower'
  | 'complete'
type Reason =
  | LotteKeypadReason
  | 'verified'
  | 'unsupported'
  | 'nonempty'
  | 'state_changed'
  | 'not_ready'
  | 'press_rejected'
  | 'mode_control_unavailable'
  | 'mode_transition_unconfirmed'
interface Result {
  stage: Stage
  reason: Reason
}
interface Deps {
  bridge: Pick<LotteKeypadBridge, 'url' | 'read' | 'press'>
  tick: () => string | null
  sleep?: (ms: number) => Promise<void>
}

// Public structure diagnostic only: no account, Vault, password key, delete, submit or attempt store.
export async function probeLotteKeypadLayouts(deps: Deps): Promise<Result> {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const { bridge } = deps
  let stage: Stage = 'initial_state'
  let reason: Reason = 'state_changed'
  const read = async (): Promise<LotteKeypadSnapshot> => {
    const url = bridge.url()
    if (!isLotteOrigin(url) || deps.tick()) throw new Error('stopped')
    const state = await bridge.read()
    if (bridge.url() !== url || deps.tick()) throw new Error('stopped')
    if (state.reason) reason = state.reason
    return state
  }
  const press = async (id: number | undefined, state: LotteKeypadSnapshot): Promise<void> => {
    if (
      !Number.isInteger(id) ||
      !Number.isSafeInteger(state.layout) ||
      state.filled !== 0 ||
      deps.tick() ||
      !isLotteOrigin(bridge.url())
    )
      throw new Error('stopped')
    if (!(await bridge.press(id!, 0, state.layout!))) {
      reason = 'press_rejected'
      throw new Error('stopped')
    }
  }
  const select = async (target: LotteKeypadMode): Promise<void> => {
    let state = await read()
    for (let turn = 0; turn < 3; turn++) {
      if (state.state !== 'open' || state.filled !== 0) throw new Error('stopped')
      if (state.mode === target) return
      const next =
        state.controls?.find((control) => control.mode === target) ??
        state.controls?.find((control) => control.mode === 'lower')
      if (!next) {
        reason = 'mode_control_unavailable'
        throw new Error('stopped')
      }
      await press(next.id, state)
      let changed = false
      for (let poll = 0; poll < 20; poll++) {
        await sleep(100)
        state = await read()
        if (state.state !== 'open' || state.filled !== 0) throw new Error('stopped')
        if (state.mode === next.mode) {
          changed = true
          break
        }
      }
      if (!changed) {
        reason = 'mode_transition_unconfirmed'
        throw new Error('stopped')
      }
    }
    throw new Error('stopped')
  }
  try {
    if (!isLotteOrigin(bridge.url())) return { stage, reason: 'unsupported' }
    let state = await read()
    if (!['open', 'closed'].includes(state.state))
      return { stage, reason: state.reason ?? 'not_ready' }
    if (state.filled !== 0) return { stage, reason: 'nonempty' }
    if (state.state === 'closed') {
      stage = 'open_keypad'
      await press(state.openId, state)
      for (let poll = 0; poll < 20; poll++) {
        await sleep(100)
        state = await read()
        if (state.state !== 'closed') break
      }
      if (state.state !== 'open' || state.filled !== 0)
        return { stage, reason: state.reason ?? 'not_ready' }
    }
    for (const target of ['lower', 'upper', 'special'] as const) {
      stage =
        target === 'lower'
          ? 'preflight_lower'
          : target === 'upper'
            ? 'preflight_upper'
            : 'preflight_special'
      await select(target)
    }
    stage = 'restore_lower'
    await select('lower')
    return { stage: 'complete', reason: 'verified' }
  } catch {
    return { stage, reason }
  }
}
