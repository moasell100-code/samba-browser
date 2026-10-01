import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HyundaiAttemptStore } from '../src/main/finance/hyundai-attempts'

const temporary: string[] = []
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})
const attempt = {
  accountId: 21,
  itemId: 22,
  revision: 'opaque-encrypted-field-revision',
  profile: 'test-profile'
}
function fixture(): { directory: string; store: HyundaiAttemptStore } {
  const directory = mkdtempSync(join(tmpdir(), 'hyundai-attempt-unit-'))
  temporary.push(directory)
  return { directory, store: new HyundaiAttemptStore(directory) }
}

describe('durable Hyundai PIN attempt latch', () => {
  it('blocks the same secret across store instances and after an uncertain result', () => {
    const { directory, store } = fixture()
    expect(store.begin(attempt)).toBe(true)
    expect(new HyundaiAttemptStore(directory).begin(attempt)).toBe(false)
    store.failed(attempt)
    expect(new HyundaiAttemptStore(directory).begin(attempt)).toBe(false)
    const raw = readFileSync(join(directory, readdirSync(directory)[0]), 'utf8')
    expect(raw).not.toContain(attempt.profile)
    expect(raw).not.toContain(attempt.revision)
    expect(JSON.parse(raw).state).toBe('failed')
  })

  it('only allows a changed encrypted secret revision after the previous attempt finishes', () => {
    const { store } = fixture()
    const updated = { ...attempt, revision: 'new-encrypted-field-revision' }
    expect(store.begin(attempt)).toBe(true)
    expect(store.begin(updated)).toBe(false)
    store.failed(attempt)
    expect(store.begin(updated)).toBe(true)
    store.failed(updated)
    expect(store.begin(updated)).toBe(false)
  })

  it('clears only after confirmed success, including manual login in the same profile', () => {
    const { store } = fixture()
    store.begin(attempt)
    store.failed(attempt)
    store.clearSignedInProfile('other-profile')
    expect(store.begin(attempt)).toBe(false)
    store.clearSignedInProfile(attempt.profile)
    expect(store.begin(attempt)).toBe(true)
    store.succeeded(attempt)
    expect(store.begin(attempt)).toBe(true)
    store.failed(attempt)
  })

  it('treats corrupted persistence as blocked, never a fresh attempt', () => {
    const { directory, store } = fixture()
    store.begin(attempt)
    store.failed(attempt)
    writeFileSync(join(directory, readdirSync(directory)[0]), 'corrupted')
    expect(() => store.begin(attempt)).toThrow()
    store.clearSignedInProfile(attempt.profile)
    expect(() => store.begin(attempt)).toThrow()
  })
})
