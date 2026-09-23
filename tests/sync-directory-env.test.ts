// 새 설치는 로컬 전용이며, 중앙 계정 연결은 운영자가 명시한 경우에만 켠다.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasDirectoryEnv, readDirectoryEnv } from '../src/main/sync/env'

afterEach(() => vi.unstubAllEnvs())

describe('자자 계정 디렉터리', () => {
  it('설정 없이 원본 제작자의 서버에 연결하지 않는다', () => {
    vi.stubEnv('SAMBA_DIRECTORY_URL', '')
    vi.stubEnv('SAMBA_DIRECTORY_ANON_KEY', '')
    expect(readDirectoryEnv()).toEqual({ url: '', anonKey: '' })
    expect(hasDirectoryEnv()).toBe(false)
  })

  it('명시적으로 지정한 프로젝트는 연결할 수 있다', () => {
    vi.stubEnv('SAMBA_DIRECTORY_URL', ' https://jaja-example.supabase.co ')
    vi.stubEnv('SAMBA_DIRECTORY_ANON_KEY', ' sb_publishable_test ')
    expect(readDirectoryEnv()).toEqual({
      url: 'https://jaja-example.supabase.co',
      anonKey: 'sb_publishable_test'
    })
    expect(hasDirectoryEnv()).toBe(true)
  })

  it.each(['SAMBA_DIRECTORY_URL', 'SAMBA_DIRECTORY_ANON_KEY'])(
    '%s 만 지정하면 다른 서버의 기본값과 섞지 않는다',
    (key) => {
      vi.stubEnv('SAMBA_DIRECTORY_URL', '')
      vi.stubEnv('SAMBA_DIRECTORY_ANON_KEY', '')
      vi.stubEnv(key, key.endsWith('_URL') ? 'https://jaja-example.supabase.co' : 'sb_test')
      expect(hasDirectoryEnv()).toBe(false)
    }
  )
})
