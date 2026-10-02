import { parse, type HTMLElement } from 'node-html-parser'

/** Fixed structural facts only. No business text, attribute values or payload values leave here. */
export function lotteResponseShapeIssues(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['shape_no_envelope']
  const content = Object.getOwnPropertyDescriptor(value, 'Content')?.value
  if (typeof content !== 'string' || Buffer.byteLength(content) > 2 * 1024 * 1024)
    return ['shape_no_content']
  if (!content.trim()) return ['shape_empty_content']
  const doc = parse(content)
  const result = new Set<string>()
  const tags = new Set([
    'LI',
    'UL',
    'DIV',
    'P',
    'SPAN',
    'STRONG',
    'EM',
    'BUTTON',
    'A',
    'BR',
    'DL',
    'DT',
    'DD',
    'SECTION',
    'ARTICLE',
    'H3'
  ])
  const param = Object.getOwnPropertyDescriptor(value, 'Param')?.value
  for (const field of ['pageNo', 'totalPage', 'nextPageNo']) {
    const number: unknown =
      param && typeof param === 'object'
        ? Object.getOwnPropertyDescriptor(param, field)?.value
        : undefined
    if (
      ((typeof number === 'string' && /^\d{1,4}$/.test(number)) || typeof number === 'number') &&
      Number.isSafeInteger(Number(number)) &&
      Number(number) >= 0 &&
      Number(number) <= 10000
    )
      result.add(`shape_${field.toLowerCase()}_${Number(number)}`)
  }
  for (const node of doc.childNodes)
    if (node.nodeType === 1 && tags.has((node as HTMLElement).tagName))
      result.add(`shape_top_${(node as HTMLElement).tagName.toLowerCase()}`)
  const publicEmpty = [
    '이용내역이없습니다.',
    '조회내역이없습니다.',
    '조회된내역이없습니다.',
    '조회결과가없습니다.',
    '내역이없습니다.',
    '이용내역이존재하지않습니다.',
    '조회하신내역이없습니다.',
    '조회된이용내역이없습니다.',
    '조회하신이용내역이없습니다.',
    '이용내역이없어요.',
    '조회내역이없어요.'
  ]
  const emptyIndex = publicEmpty.indexOf(doc.textContent.replace(/\s+/g, ''))
  if (emptyIndex >= 0) result.add(`shape_empty_label_${emptyIndex}`)
  for (const name of ['noData', 'nodata', 'no_data', 'noneData', 'empty'])
    if (doc.querySelector('.' + name)) result.add(`shape_empty_class_${name.toLowerCase()}`)
  const empty = doc.querySelector('.noData')
  if (empty) {
    for (const child of [empty, ...empty.querySelectorAll('*')].slice(0, 20)) {
      if (tags.has(child.tagName)) result.add('shape_empty_node_' + child.tagName.toLowerCase())
      const matched = publicEmpty
        .map((label) => label.replace(/[.!]$/, ''))
        .indexOf(child.textContent.replace(/\s+/g, '').replace(/[.!]$/, ''))
      if (matched >= 0) result.add(`shape_empty_node_label_${matched}`)
    }
  }
  const row = doc.querySelector('li.toggle') ?? doc.querySelector('li.toggleON')
  if (!row) return [...result]
  const detail = row.querySelector('div.useList')
  result.add(
    detail
      ? detail.querySelector('ul')
        ? 'shape_detail_list'
        : 'shape_detail_empty'
      : 'shape_detail_absent'
  )
  const keys = new Set([
    'aprDeAm',
    'aprDeKeyV',
    'aprDtti',
    'cdno',
    'deDt',
    'gramFlwSeq',
    'auPartId',
    'aprno',
    'aprTrc',
    'byRc',
    'byCanRc',
    'mcNm',
    'aprRsc'
  ])
  for (const node of [row, ...row.querySelectorAll('*')].slice(0, 100)) {
    for (const [name, raw] of Object.entries(node.attributes)) {
      if (!/^data-[a-z-]{1,32}$/.test(name)) continue
      result.add('shape_attr_' + name.replaceAll('-', '_'))
      if (raw.length > 16000) continue
      try {
        const payload: unknown = JSON.parse(raw)
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue
        result.add('shape_json_' + name.replaceAll('-', '_'))
        if (tags.has(node.tagName)) result.add('shape_json_node_' + node.tagName.toLowerCase())
        for (const key of keys)
          if (Object.hasOwn(payload, key)) result.add('shape_key_' + key.toLowerCase())
      } catch {
        /* Never include malformed payload data. */
      }
    }
  }
  return [...result].slice(0, 50)
}
