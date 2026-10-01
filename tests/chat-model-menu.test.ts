import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { IpcResult } from '../src/shared/ipc'
import type { AiProviderId, TaskModels } from '../src/shared/ai'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'
import { remapOnProviderChange, taskModelChoices } from '../src/main/ai/models'

// 입력줄 아래 "모델 · 강도" 선택만 확인한다. 스토어는 순수 zustand 라 node 에서 그대로 돌아간다
let settings: Settings = { ...DEFAULT_SETTINGS }
let taskModels: TaskModels = { ...DEFAULT_SETTINGS.taskModels }
let provider: AiProviderId = 'claude_subscription'

const aiTaskModels = vi.fn(
  async (): Promise<
    IpcResult<{ provider: AiProviderId; taskModels: TaskModels; choices: string[] }>
  > => ({
    ok: true,
    data: {
      provider,
      taskModels,
      choices: taskModelChoices(provider)
    }
  })
)
const setProvider = vi.fn(async (next: AiProviderId) => {
  const mapped = remapOnProviderChange(taskModels, provider, next)
  provider = next
  taskModels = mapped.models
  return { ok: true as const, data: { provider, taskModels, changed: mapped.changed } }
})
const setTaskModel = vi.fn(async (key: string, model: string): Promise<IpcResult<TaskModels>> => {
  taskModels = { ...taskModels, [key]: model }
  return { ok: true, data: taskModels }
})
const settingsGet = vi.fn(async (): Promise<IpcResult<Settings>> => ({ ok: true, data: settings }))
const settingsSet = vi.fn(async (patch: Partial<Settings>): Promise<IpcResult<Settings>> => {
  settings = { ...settings, ...patch }
  return { ok: true, data: settings }
})

const win = {
  samba: {
    agent: { run: vi.fn(), stop: vi.fn(), confirmReply: vi.fn(), onEvent: vi.fn() },
    ai: { taskModels: aiTaskModels, setTaskModel, setProvider },
    settings: { get: settingsGet, set: settingsSet }
  }
}
Object.assign(globalThis, { window: win })

const { useChatStore } = await import('../src/renderer/src/stores/chatStore')
const { useAiStore } = await import('../src/renderer/src/stores/aiStore')

describe('채팅 입력줄 모델·추론 강도', () => {
  beforeEach(() => {
    settings = { ...DEFAULT_SETTINGS }
    taskModels = { ...DEFAULT_SETTINGS.taskModels }
    provider = 'claude_subscription'
    setProvider.mockClear()
    setTaskModel.mockClear()
    settingsSet.mockClear()
    useChatStore.setState({
      model: DEFAULT_SETTINGS.taskModels.standard,
      modelChoices: [],
      effort: DEFAULT_SETTINGS.agentEffort
    })
  })

  it('작업별 모델 표의 표준 칸과 후보 목록을 읽어 온다', async () => {
    await useChatStore.getState().loadModelMenu()
    expect(useChatStore.getState().model).toBe('claude-sonnet-5')
    expect(useChatStore.getState().modelChoices).toEqual([
      'claude-fable-5-1',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001'
    ])
  })

  it('저장된 추론 강도를 읽어 온다', async () => {
    settings = { ...settings, agentEffort: 'high' }
    await useChatStore.getState().loadModelMenu()
    expect(useChatStore.getState().effort).toBe('high')
  })

  it('모델을 고르면 표준 칸에만 저장한다', async () => {
    await useChatStore.getState().setModel('opus')
    expect(setTaskModel).toHaveBeenCalledWith('standard', 'opus')
    expect(useChatStore.getState().model).toBe('opus')
    expect(taskModels.standard).toBe('opus')
    // 하위 호환 키(settings.model)는 건드리지 않는다 — 진실은 taskModels.standard 뿐이다
    expect(settingsSet).not.toHaveBeenCalled()
  })

  it('강도를 고르면 agentEffort 설정에 저장한다', async () => {
    await useChatStore.getState().setEffort('low')
    expect(settingsSet).toHaveBeenCalledWith({ agentEffort: 'low' })
    expect(useChatStore.getState().effort).toBe('low')
    expect(settings.agentEffort).toBe('low')
  })

  it('저장한 값이 다시 읽어도 그대로다', async () => {
    await useChatStore.getState().setEffort('high')
    await useChatStore.getState().setModel('haiku')
    useChatStore.setState({ model: 'sonnet', effort: 'medium' })
    await useChatStore.getState().loadModelMenu()
    expect(useChatStore.getState().model).toBe('haiku')
    expect(useChatStore.getState().effort).toBe('high')
  })

  it('Claude→Codex 전환이 서버 remap 결과를 열린 채팅 모델·후보에 즉시 반영한다', async () => {
    await useChatStore.getState().loadModelMenu()
    useChatStore.setState({ effort: 'high' })
    expect(useChatStore.getState().model).toBe('claude-sonnet-5')
    await useAiStore.getState().setProvider('codex_subscription')
    expect(useChatStore.getState().model).toBe(taskModels.standard)
    expect(useChatStore.getState().model).toBe('gpt-5.6')
    expect(useChatStore.getState().modelChoices).toEqual(taskModelChoices('codex_subscription'))
    expect(useChatStore.getState().effort).toBe('high')
    expect(setTaskModel).not.toHaveBeenCalled()
    expect(settingsSet).not.toHaveBeenCalled()
  })

  it('같은 제공자 재선택은 사용자 지정 모델을 기본값으로 덮지 않는다', async () => {
    provider = 'codex_subscription'
    taskModels = { ...taskModels, standard: 'my-custom-codex-model' }
    await useAiStore.getState().setProvider('codex_subscription')
    expect(useChatStore.getState().model).toBe('my-custom-codex-model')
    expect(taskModels.standard).toBe('my-custom-codex-model')
    expect(setTaskModel).not.toHaveBeenCalled()
  })

  it('설정에서 표준 모델을 직접 수정해도 열린 채팅에 같은 값이 보인다', async () => {
    await useAiStore.getState().setTaskModel('standard', 'my-custom-model')
    expect(useChatStore.getState().model).toBe('my-custom-model')
    expect(setTaskModel).toHaveBeenCalledOnce()
    expect(settingsSet).not.toHaveBeenCalled()
  })
})
