import { describe, expect, it } from 'vitest'
import { summarizeLotteHistoryContent } from '../src/main/finance/lotte-response-summary'

const OTHER = { format: 'other', root: 'unrecognized', rowCount: null }
const UNKNOWN = { format: 'html', root: 'unrecognized', rowCount: null }
function row(): string {
  return '<li class="toggle"><strong>synthetic-merchant</strong><div class="info"><span>synthetic-date</span><span>synthetic-card</span><span>synthetic-method</span></div><em><span>synthetic-amount</span></em><div class="useList"><ul><li>synthetic-detail<span>private-detail</span></li></ul></div></li>'
}
function full(rows: string): string {
  return `<ul id="useCardList" class="useCardList type02">${rows}</ul>`
}
function summarize(Content: string): ReturnType<typeof summarizeLotteHistoryContent> {
  return summarizeLotteHistoryContent({ Content })
}

describe('Lotte response Content structure summary', () => {
  it('counts only direct transaction rows in a unique verified full root', () => {
    expect(summarize(full(row() + row()))).toEqual({ format: 'html', root: 'full', rowCount: 2 })
  })
  it('recognizes strict top-level transaction fragments with whitespace and comments', () => {
    expect(summarize(`\n${row()}<!-- paging -->\n${row()}`)).toEqual({
      format: 'html',
      root: 'fragment',
      rowCount: 2
    })
  })
  it('distinguishes a complete empty root from empty or unrelated content', () => {
    expect(summarize(full(' \n<!-- empty -->'))).toEqual({
      format: 'html',
      root: 'full',
      rowCount: 0
    })
    for (const content of ['', ' ', '<div></div>', 'not html'])
      expect(summarize(content)).toEqual(UNKNOWN)
  })
  it('supports the verified cancellation and partial-cancellation structures', () => {
    const cancel = row()
      .replace('class="toggle"', 'class="toggle cancel"')
      .replace('</div><em>', '<span>취소</span></div><em>')
    const partial = row()
      .replace('</div><em>', '<span>부분취소</span></div><em class="parttot">')
      .replace('</em>', '<span>synthetic-second-amount</span></em>')
    expect(summarize(full(cancel + partial))).toEqual({ format: 'html', root: 'full', rowCount: 2 })
  })
  it('does not count nested detail lists or nested info spans as transactions or metadata', () => {
    const details = row().replace(
      'private-detail',
      '<div class="info"><span>nested</span><span>nested</span><span>nested</span></div>'
    )
    expect(summarize(full(details))).toEqual({ format: 'html', root: 'full', rowCount: 1 })
    const missingHeadInfo = row().replace('<div class="info">', '<div class="unrelated">')
    expect(summarize(full(missingHeadInfo))).toEqual(UNKNOWN)
  })
  it('does not execute scripts, load resources, or return transaction values', () => {
    const input = `<script>throw new Error('execute-secret')</script>${full(row())}<img src="https://invalid.test/private">`
    const result = summarize(input)
    expect(result).toEqual({ format: 'html', root: 'full', rowCount: 1 })
    expect(JSON.stringify(result)).not.toMatch(/synthetic|private|script|invalid|execute/)
  })
  it('does not recognize markup embedded in script or inert template content', () => {
    for (const content of [
      `<script>${full(row())}</script>`,
      `<template>${full(row())}</template>`,
      `<noscript>${full(row())}</noscript>`
    ]) {
      expect(summarize(content)).toEqual(UNKNOWN)
    }
  })
  it.each([
    () => full(row()) + full(row()),
    () => full(row()).replace('class="useCardList type02"', 'class="unrelated"'),
    () => full(row()).replace('<ul ', '<ul hidden '),
    () => full(row()).replace('<li ', '<li style="display:none" '),
    () => full(row()).replace('<strong>', '<b>').replace('</strong>', '</b>'),
    () => full(row() + '<li>summary</li>'),
    () => `<div>${row()}</div>`,
    () => row().replace('class="toggle"', 'class="unrelated"'),
    () => row() + '<script>ignored()</script>',
    () => row() + 'unexpected trailer'
  ])('rejects ambiguous or unverified structures %#', (make) => {
    expect(summarize(make())).toEqual(UNKNOWN)
  })
  it('requires an own Content string without evaluating property getters', () => {
    for (const value of [
      null,
      [],
      'html',
      { content: full(row()) },
      { Content: {} },
      Object.create({ Content: full(row()) })
    ]) {
      expect(summarizeLotteHistoryContent(value)).toEqual(OTHER)
    }
    const value = Object.defineProperty({}, 'Content', {
      get: () => {
        throw new Error('getter must not run')
      }
    })
    expect(summarizeLotteHistoryContent(value)).toEqual(OTHER)
  })
  it('fails closed for oversized Content, excessive rows, nodes, or depth', () => {
    expect(summarize('x'.repeat(2 * 1024 * 1024 + 1))).toEqual(UNKNOWN)
    expect(summarize('가'.repeat(800_000))).toEqual(UNKNOWN)
    expect(summarize(full(row().repeat(1001)))).toEqual(UNKNOWN)
    expect(summarize(`<div>${'<i></i>'.repeat(20_001)}</div>`)).toEqual(UNKNOWN)
    expect(summarize('<div>'.repeat(31) + full(row()) + '</div>'.repeat(31))).toEqual(UNKNOWN)
  })
})
