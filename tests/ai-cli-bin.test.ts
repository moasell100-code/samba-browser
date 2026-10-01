// Windows npm 셔틀(codex.cmd)을 node + .js 로 풀어 실행하는 규칙
import { describe, it, expect } from 'vitest'
import { resolveCliBin, scriptOfNpmShim, type CliResolveDeps } from '../src/main/ai/cli-bin'

const NPM = 'C:\\Users\\u\\AppData\\Roaming\\npm'
const NODE = 'C:\\Program Files\\nodejs\\node.exe'
const SHIM = [
  '@ECHO off',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ')',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*'
].join('\r\n')

function deps(over: Partial<CliResolveDeps> & { files?: string[] } = {}): CliResolveDeps {
  const files = new Set((over.files ?? []).map((f) => f.toLowerCase()))
  return {
    platform: over.platform ?? 'win32',
    env: over.env ?? {
      PATH: 'C:\\Windows;C:\\Program Files\\nodejs',
      APPDATA: 'C:\\Users\\u\\AppData\\Roaming'
    },
    exists: over.exists ?? ((p) => files.has(p.toLowerCase())),
    readFile: over.readFile ?? (() => SHIM),
    directories: over.directories,
    modified: over.modified
  }
}

describe('resolveCliBin', () => {
  it('Windows 가 아니면 이름 그대로', () => {
    expect(resolveCliBin('codex', deps({ platform: 'linux' }))).toEqual({
      command: 'codex',
      prefixArgs: []
    })
  })

  it('npm 전역 폴더의 codex.cmd 를 찾아 셔틀 안의 .js 를 node 로 돌린다(실기: Codex 가 있는데 "설치되지 않음")', () => {
    const r = resolveCliBin(
      'codex',
      deps({
        files: [`${NPM}\\codex.cmd`, `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`, NODE]
      })
    )
    expect(r.command).toBe(NODE)
    expect(r.prefixArgs).toEqual([`${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`])
  })

  it('.exe 가 있으면 그것을 우선 쓴다(claude.exe 처럼 네이티브 설치)', () => {
    const r = resolveCliBin(
      'claude',
      deps({
        env: { PATH: 'C:\\Users\\u\\.local\\bin' },
        files: ['C:\\Users\\u\\.local\\bin\\claude.exe']
      })
    )
    expect(r).toEqual({ command: 'C:\\Users\\u\\.local\\bin\\claude.exe', prefixArgs: [] })
  })

  it('Codex는 앞선 구형 npm 셔틀보다 PATH 뒤쪽의 데스크톱 native CLI를 우선한다', () => {
    const native = 'C:\\Users\\u\\AppData\\Local\\OpenAI\\Codex\\bin\\new\\codex.exe'
    const r = resolveCliBin(
      'codex',
      deps({
        env: { PATH: `${NPM};C:\\Users\\u\\AppData\\Local\\OpenAI\\Codex\\bin\\new` },
        files: [
          `${NPM}\\codex.cmd`,
          `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`,
          native,
          NODE
        ]
      })
    )
    expect(r).toEqual({ command: native, prefixArgs: [] })
  })

  it('Codex 앱에서 시작하지 않은 바로가기도 기존 per-user CLI 중 최신 파일을 찾는다', () => {
    const root = 'C:\\Users\\u\\AppData\\Local\\OpenAI\\Codex\\bin'
    const native = `${root}\\new\\codex.exe`
    const r = resolveCliBin(
      'codex',
      deps({
        env: { PATH: NPM, LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
        files: [
          `${NPM}\\codex.cmd`,
          `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`,
          `${root}\\old\\codex.exe`,
          native
        ],
        directories: () => ['old', 'new', '../invalid'],
        modified: (path) => (path === native ? 2 : 1)
      })
    )
    expect(r).toEqual({ command: native, prefixArgs: [] })
  })

  it('데스크톱 CLI 폴더를 읽지 못하면 기존 npm 경로로 돌아간다', () => {
    const r = resolveCliBin(
      'codex',
      deps({
        env: { PATH: NPM, LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
        files: [`${NPM}\\codex.cmd`, `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`],
        directories: () => {
          throw new Error('unavailable')
        }
      })
    )
    expect(r.prefixArgs).toEqual([`${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`])
  })

  it('Claude의 기존 PATH 우선순위는 바꾸지 않는다', () => {
    const r = resolveCliBin(
      'claude',
      deps({
        env: { PATH: `${NPM};C:\\native` },
        files: [
          `${NPM}\\claude.cmd`,
          `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`,
          'C:\\native\\claude.exe'
        ]
      })
    )
    expect(r.prefixArgs).toHaveLength(1)
  })

  it('아무것도 못 찾으면 이름 그대로(예전과 같은 실패)', () => {
    expect(resolveCliBin('codex', deps())).toEqual({ command: 'codex', prefixArgs: [] })
  })

  it('셔틀의 .js 가 없으면 셔틀을 믿지 않는다', () => {
    expect(resolveCliBin('codex', deps({ files: [`${NPM}\\codex.cmd`] }))).toEqual({
      command: 'codex',
      prefixArgs: []
    })
  })
})

describe('scriptOfNpmShim', () => {
  it('"%dp0%\\...\\x.js" 를 뽑는다', () => {
    expect(scriptOfNpmShim(SHIM, 'C:\\npm')).toBe(
      'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'
    )
  })
  it('.js 가 없으면 null', () => {
    expect(scriptOfNpmShim('@ECHO off\r\n"%dp0%\\foo.exe" %*', 'C:\\npm')).toBeNull()
  })
})
