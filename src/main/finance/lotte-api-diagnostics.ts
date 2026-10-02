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
  const knownLabels = [
    '이용일시',
    '거래유형',
    '승인번호',
    '취소여부',
    '포인트사용',
    '매입여부',
    '취소금액',
    '매입금액',
    '취소일자',
    '이용일자',
    '이용금액',
    '승인금액',
    '승인일시',
    '카드번호',
    '사용카드',
    '가맹점명',
    '거래일시'
  ]
  const roots = doc.childNodes.filter((node) => node.nodeType === 1) as HTMLElement[]
  if (roots.some((node) => node.tagName === 'UL')) {
    result.add('shape_detail_top_count_' + roots.length)
    const pairs = doc.querySelectorAll('ul > li')
    result.add('shape_detail_pair_count_' + pairs.length)
    for (const pair of pairs.slice(0, 30)) {
      const directText = pair.childNodes
        .filter((node) => node.nodeType === 3)
        .map((node) => node.text)
        .join('')
        .replace(/\s+/g, '')
      const index = knownLabels.indexOf(directText)
      if (index >= 0) result.add('shape_detail_label_' + index)
    }
  }
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
    const emptyText = empty.text.replace(/\s+/g, '')
    if (!emptyText) result.add('shape_empty_text_blank')
    if (emptyText.length < 150) result.add('shape_empty_text_length_' + emptyText.length)
    const count =
      param && typeof param === 'object'
        ? Object.getOwnPropertyDescriptor(param, 'totalCnt')?.value
        : undefined
    result.add(
      count === 0 || count === '0'
        ? 'shape_empty_totalcnt_zero'
        : count === undefined
          ? 'shape_empty_totalcnt_absent'
          : 'shape_empty_totalcnt_other'
    )
    for (const [index, phrase] of [
      '조회된이용내역이없습니다',
      '조회하신이용내역이없습니다',
      '조회내역이없습니다',
      '이용내역이없습니다',
      '내역이없습니다',
      '내용이없습니다',
      '데이터가없습니다',
      '조회된내역이없습니다',
      '이용내역없음',
      '조회결과가없습니다'
    ].entries())
      if (emptyText.includes(phrase)) result.add('shape_empty_phrase_' + index)
    const vocabulary = [
      '조회하신',
      '선택하신',
      '조건에',
      '해당하는',
      '이용내역이',
      '없습니다.',
      '없습니다',
      '조회된',
      '내역이',
      '기간에',
      '해당',
      '카드',
      '승인',
      '이용',
      '내역은',
      '없어요.',
      '조회',
      '결과가',
      '데이터가',
      '일치하는',
      '검색된',
      '기간의',
      '이용내역은',
      '조회내역이',
      '거래내역이',
      '거래',
      '존재하지',
      '않습니다.',
      '기간',
      '해당기간에',
      '검색',
      '정보가',
      '요청하신',
      '내역',
      '이용내역',
      '승인내역이',
      '조회하신기간에',
      '조회하신기간의',
      '조건과'
    ]
    const words = empty.textContent
      .replace(/\u00a0/g, ' ')
      .trim()
      .split(/\s+/)
    const codes = words.map((word) => vocabulary.indexOf(word))
    if (codes.length <= 20 && codes.every((code) => code >= 0))
      result.add('shape_empty_words_' + codes.join('_'))
    const direct = empty.childNodes.filter((node) => node.nodeType === 1)
    result.add('shape_empty_children_' + direct.length)
    result.add('shape_empty_roots_' + doc.querySelectorAll('.noData').length)
    result.add('shape_top_elements_' + doc.childNodes.filter((node) => node.nodeType === 1).length)
    const parentTag = empty.parentNode?.tagName
    if (parentTag && tags.has(parentTag))
      result.add('shape_empty_parent_' + parentTag.toLowerCase())
    if (doc.querySelector('#useCardList') === empty.parentNode)
      result.add('shape_empty_parent_usecardlist')
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
