import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { saveCardExcel, validExcelRange } from '../src/main/finance/card-excel-save'

const roots: string[] = []
const RANGE = { from: '2026-07-01', to: '2026-07-31' }
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'jaja-card-excel-save-test-'))
  roots.push(root)
  return join(root, 'exports')
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep + 'jaja-card-excel-save-test-'))
      throw new Error('Unexpected test directory')
    await rm(absolute, { recursive: true, force: true })
  }
})
function file(): Parameters<typeof saveCardExcel>[1] {
  return {
    issuer: 'lotte_card',
    range: { ...RANGE },
    bytes: Buffer.from('synthetic-private-workbook-contents'),
    extension: 'xls',
    expectedRows: null
  }
}

describe('immutable local card Excel receipts', () => {
  it('saves original contents once and returns only content hash, local path and aggregate metadata', async () => {
    const dir = await directory()
    const source = file()
    const receipt = (await saveCardExcel(dir, source)) as {
      path: string
      sha256: string
      alreadySaved: boolean
      bytes: number
    }
    expect(receipt.sha256).toBe(createHash('sha256').update(source.bytes).digest('hex'))
    expect(receipt.path).toBe(
      join(dir, `lotte_card_all_2026-07-01_2026-07-31_${receipt.sha256.slice(0, 12)}.xls`)
    )
    expect(await readFile(receipt.path)).toEqual(source.bytes)
    expect(receipt.alreadySaved).toBe(false)
    expect(receipt.bytes).toBe(source.bytes.length)
    expect(JSON.stringify(receipt)).not.toContain('synthetic-private-workbook-contents')
    expect(await saveCardExcel(dir, source)).toMatchObject({
      path: receipt.path,
      alreadySaved: true
    })
    expect(await readdir(dir)).toHaveLength(1)
  })

  it('does not overwrite a mismatched existing file at the content-addressed name', async () => {
    const dir = await directory()
    const source = file()
    const receipt = (await saveCardExcel(dir, source)) as { path: string }
    await writeFile(receipt.path, 'synthetic-tampered-file')
    await expect(saveCardExcel(dir, source)).rejects.toThrow('Card export save failed')
    expect(await readFile(receipt.path, 'utf8')).toBe('synthetic-tampered-file')
  })

  it('rejects a linked export directory without writing a workbook through it', async () => {
    const dir = await directory()
    const target = join(roots[roots.length - 1], 'other')
    await mkdir(target)
    await symlink(target, dir, 'junction')
    await expect(saveCardExcel(dir, file())).rejects.toThrow('Invalid card export directory')
    expect(await readdir(target)).toEqual([])
  })

  it.each([
    { from: '2026-07-01', to: '2026-08-01' },
    { from: '2026-07-30', to: '2026-07-01' },
    { from: '2026-02-29', to: '2026-02-29' }
  ])('enforces real dates within one calendar month (%j)', async (range) => {
    expect(validExcelRange(range)).toBe(false)
    await expect(saveCardExcel(await directory(), { ...file(), range })).rejects.toThrow(
      'Invalid card export'
    )
  })

  it('allows a shorter partial month and reports a verified empty result without creating a file', async () => {
    const dir = await directory()
    const range = { from: '2026-10-01', to: '2026-10-06' }
    expect(validExcelRange(range)).toBe(true)
    expect(
      await saveCardExcel(dir, { ...file(), range, bytes: Buffer.alloc(0), expectedRows: 0 })
    ).toEqual({ state: 'empty', issuer: 'lotte_card', range, scope: 'all', expectedRows: 0 })
    await expect(readdir(dir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(saveCardExcel(dir, { ...file(), bytes: Buffer.alloc(0) })).rejects.toThrow(
      'Invalid card export'
    )
  })

  it('rejects unsafe file naming components, unknown issuers and oversized content', async () => {
    const dir = await directory()
    const invalids = [
      { scope: '../../escape' },
      { extension: '../../xls' },
      { issuer: 'unrecognized' },
      { bytes: Buffer.alloc(25 * 1024 * 1024 + 1) }
    ]
    for (const value of invalids) {
      await expect(
        saveCardExcel(dir, { ...file(), ...value } as Parameters<typeof saveCardExcel>[1])
      ).rejects.toThrow('Invalid card export')
    }
    await expect(readdir(dir)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
