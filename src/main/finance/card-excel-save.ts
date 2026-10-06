import { createHash } from 'node:crypto'
import { mkdir, writeFile, lstat, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isCardDate } from './card-date-range'
import type { CardDateRange } from './card-api-types'
import type { CardDiagnosticIssuer } from './card-diagnostics-mcp'

export function validExcelRange(range: CardDateRange): boolean {
  return (
    isCardDate(range.from) &&
    isCardDate(range.to) &&
    range.from <= range.to &&
    range.from.slice(0, 7) === range.to.slice(0, 7)
  )
}

/** Persist original binary contents; return only a receipt, never account or cell data. */
export async function saveCardExcel(
  directory: string,
  file: {
    issuer: CardDiagnosticIssuer
    range: CardDateRange
    scope?: string
    bytes: Buffer
    extension: 'xls' | 'xlsx'
    expectedRows?: number | null
    rowLimitPossible?: boolean
    reportedTotal?: number | null
    queryRows?: number | null
  }
): Promise<unknown> {
  if (
    !validExcelRange(file.range) ||
    !['hyundai_card', 'samsung_card', 'lotte_card'].includes(file.issuer) ||
    !['xls', 'xlsx'].includes(file.extension) ||
    !/^[a-z_]{1,64}$/.test(file.scope ?? 'all') ||
    file.bytes.length > 25 * 1024 * 1024
  )
    throw new Error('Invalid card export')
  if (!file.bytes.length) {
    if (file.expectedRows !== 0) throw new Error('Invalid card export')
    return {
      state: 'empty',
      issuer: file.issuer,
      range: file.range,
      scope: file.scope ?? 'all',
      expectedRows: 0
    }
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (
    (await lstat(directory)).isSymbolicLink() ||
    resolve(await realpath(directory)).toLowerCase() !== resolve(directory).toLowerCase()
  )
    throw new Error('Invalid card export directory')
  const sha256 = createHash('sha256').update(file.bytes).digest('hex')
  const filename = `${file.issuer}_${file.scope ?? 'all'}_${file.range.from}_${file.range.to}_${sha256.slice(0, 12)}.${file.extension}`
  const path = join(directory, filename)
  let alreadySaved = false
  try {
    await writeFile(path, file.bytes, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
      throw new Error('Card export save failed')
    // A prior immutable file with the content hash in its name is reusable.
    const { readFile } = await import('node:fs/promises')
    if (
      (await lstat(path)).isSymbolicLink() ||
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex') !== sha256
    )
      throw new Error('Card export save failed')
    alreadySaved = true
  }
  return {
    state: 'saved',
    issuer: file.issuer,
    range: file.range,
    scope: file.scope ?? 'all',
    path,
    sha256,
    bytes: file.bytes.length,
    expectedRows: file.expectedRows ?? null,
    alreadySaved,
    ...(file.rowLimitPossible === undefined ? {} : { rowLimitPossible: file.rowLimitPossible }),
    ...(file.reportedTotal === undefined ? {} : { reportedTotal: file.reportedTotal }),
    ...(file.queryRows === undefined ? {} : { queryRows: file.queryRows })
  }
}
