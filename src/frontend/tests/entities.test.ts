import { expect, it, vi } from 'vitest'
vi.mock('../src/lib/historyApi', async () => {
  const { memoryHistoryApi } = await import('./fixtures/historyApi')
  return { historyApi: memoryHistoryApi() }
})
import { attachInformation, hashText, validateStructure } from '../src/lib/contentGraph'
import { entityAnswer, entityResult, entitySession } from './fixtures/entities'
import { saveSession } from '../src/lib/db'
import { useStore } from '../src/store'
import { previousNodes } from '../src/components/PreviousNodeButton'
import { entityInformation, nodeContext, nodeText, responseParentId } from '../src/lib/nodeActions'
import { ENTITY_KIND_LABELS } from '../src/types'

it('shares a qualified entity across cards and later answers without moving existing nodes', async () => {
  const original = entitySession(), payload = entityResult(await hashText(entityAnswer))
  validateStructure(payload, entityAnswer, payload.text_hash)
  const first = attachInformation(original, 'response_entity', payload)
  const hub = first.nodes.find((node) => node.type === 'entity')!
  expect(first.contentGraph!.relations.filter((edge) => edge.target === hub.id && edge.kind === 'has_entity')).toHaveLength(1)
  expect(first.contentGraph!.relations.filter((edge) => edge.source === hub.id && edge.kind === 'has_information')).toHaveLength(2)
  expect(first.nodes.filter((node) => node.type === 'information').every((node) => node.position.x > hub.position.x + hub.width!)).toBe(true)
  expect(hub.position.x).toBeGreaterThan(first.nodes[0].position.x + first.nodes[0].width!)
  expect(previousNodes(first, first.nodes.find((node) => node.type === 'information')!.id).map((node) => node.id)).toEqual([hub.id])
  expect(previousNodes(first, hub.id).map((node) => node.id)).toEqual(['response_entity'])
  const second = structuredClone(first)
  second.nodes.push({ ...structuredClone(second.nodes[0]), id: 'response_second', position: { x: 0, y: 1500 } })
  const next = attachInformation(second, 'response_second', payload)
  expect(next.nodes.filter((node) => node.type === 'entity')).toEqual([hub])
  expect(next.contentGraph!.relations.filter((edge) => edge.target === hub.id && edge.kind === 'has_entity')).toHaveLength(2)
  expect(next.contentGraph!.relations.filter((edge) => edge.source === hub.id && edge.kind === 'has_information')).toHaveLength(4)
  expect(next.viewport).toEqual(original.viewport)
  expect(next.nodes.slice(0, first.nodes.length)).toEqual(first.nodes)
  expect(attachInformation(next, 'response_second', payload)).toEqual(next)
  await saveSession(next)
  const fetch = vi.spyOn(globalThis, 'fetch')
  await useStore.getState().initialize()
  await useStore.getState().open(next.id)
  expect(useStore.getState().session!.contentGraph).toEqual(next.contentGraph)
  expect(useStore.getState().session!.viewport).toEqual(next.viewport)
  expect(fetch).not.toHaveBeenCalled()
  fetch.mockRestore()
})

it('shares a comparison card between entities without duplicating information or losing provenance', () => {
  const payload = entityResult('hash')
  payload.entities!.push({ ...structuredClone(payload.entities![0]), key: 'b'.repeat(24), name: '다른 대상', qualifier: null })
  const session = attachInformation(entitySession(), 'response_entity', payload)
  expect(session.nodes.filter((node) => node.type === 'information')).toHaveLength(2)
  expect(session.nodes.filter((node) => node.type === 'entity')).toHaveLength(2)
  expect(session.contentGraph!.relations.filter((edge) => edge.kind === 'has_information')).toHaveLength(4)
  expect(session.contentGraph!.relations.filter((edge) => edge.kind === 'has_extract')).toHaveLength(2)
  expect(session.contentGraph!.relations.filter((edge) => edge.kind === 'about')).toHaveLength(0)
})

it('keeps unqualified or differently qualified homonyms separate', () => {
  const payload = entityResult('hash')
  const first = attachInformation(entitySession(), 'response_entity', payload)
  first.nodes.push({ ...structuredClone(first.nodes[0]), id: 'response_second' })
  for (const qualifier of [null, '다른 분야']) {
    const other = structuredClone(payload)
    other.entities![0].qualifier = qualifier
    expect(attachInformation(first, 'response_second', other).nodes.filter((n) => n.type === 'entity')).toHaveLength(2)
  }
})

it('isolates invented entities, aliases, qualifiers and unrelated references from valid cards', async () => {
  const payload = entityResult(await hashText(entityAnswer))
  for (const mutate of [
    (value: typeof payload) => { value.entities![0].name = '꾸며낸 이름' },
    (value: typeof payload) => { value.entities![0].aliases = ['Invented translation'] },
    (value: typeof payload) => { value.entities![0].qualifier = '없는 분야' },
  ]) {
    const bad = structuredClone(payload)
    mutate(bad)
    const result = validateStructure(bad, entityAnswer, payload.text_hash)
    expect(result.entities).toEqual([])
    expect(result.items).toEqual(payload.items)
  }
})

it('keeps a heading-grounded entity when cards omit its name and isolates a bad link', async () => {
  const payload = entityResult('hash')
  const heading = '# 벡터 서치 · 검색 기술'
  const body = '이 기술은 의미를 비교합니다.'
  const answer = `${heading}\n${body}`
  const span = { start: heading.length + 1, end: answer.length, quote: body }
  payload.text_hash = await hashText(answer)
  payload.items = [{ ...payload.items[0], title: span, excerpt: span,
    presentation: { heading: '작동 방식', summary: { text: body, references: [span] }, sections: [], table: null } }]
  payload.entities![0].references = [{ start: 0, end: heading.length, quote: heading }]
  payload.entities![0].links = [{ item_key: payload.items[0].key, references: [span] },
    { item_key: 'f'.repeat(24), references: [span] }]
  const valid = validateStructure(payload, answer, payload.text_hash)
  expect(valid.entities).toHaveLength(1)
  expect(valid.entities![0].links).toHaveLength(1)
  const session = entitySession()
  if (session.nodes[0].type === 'response') session.nodes[0].data.text = answer
  const result = attachInformation(session, 'response_entity', valid)
  const entity = Object.values(result.contentGraph!.entities).find((entry) => entry.type === 'entity')!
  expect(entity.type === 'entity' && entity.observations[0].references).toEqual(payload.entities![0].references)
  const fabricated = structuredClone(payload)
  fabricated.entities![0].references = [{ start: 0, end: heading.length, quote: '조작된 이름 근거' }]
  expect(validateStructure(fabricated, answer, payload.text_hash).entities).toEqual([])
})

it('copies and passes connected information, including legacy edges, without including unrelated cards', () => {
  const session = attachInformation(entitySession(), 'response_entity', entityResult('hash'))
  const hub = session.nodes.find((n) => n.type === 'entity')!
  const info = entityInformation(session, hub.id)
  session.contentGraph!.entities.unrelated = { ...info[0], id: 'unrelated', presentation: null,
    excerpt: { start: 0, end: 4, quote: '무관한 내용' } }
  session.contentGraph!.relations.push({ id: 'legacy', source: info[0].id, target: hub.id,
    kind: 'about', responseId: 'response_entity', spans: [] })
  expect(entityInformation(session, hub.id)).toHaveLength(2)
  const copied = nodeText(session, hub.id)
  expect(copied).toContain('벡터 서치 (기술)')
  expect(copied).toContain('검색 기술의 정의')
  expect(copied).toContain('의미 비교')
  expect(copied).not.toContain('무관한 내용')
  expect(nodeContext(session, hub.id)).toEqual({ node_id: hub.id, kind: 'entity', title: '벡터 서치', text: copied })
  const response = { id: 'followup', type: 'response' as const, position: { x: 0, y: 0 },
    data: { prompt: '더 알려줘', text: '', status: 'completed' as const, parentId: 'response_entity' } }
  session.nodes.push(response)
  session.contentGraph!.relations.push({ id: 'context', source: response.id, target: hub.id,
    kind: 'uses_context', responseId: response.id, spans: [] })
  expect(responseParentId(session, response)).toBe(hub.id)
  for (const item of info) {
    item.presentation = null
    item.excerpt.quote = `${item.id} ` + '🐇조건·예외 '.repeat(4000)
  }
  const bounded = nodeContext(session, hub.id)!.text
  expect(Array.from(bounded).length).toBeLessThanOrEqual(12000)
  expect(bounded).toContain(info[0].id)
  expect(bounded).toContain(info[1].id)
  expect(bounded).toContain('일부 내용 생략')
  expect(nodeContext({ ...session, mode: 'sample' }, hub.id)).toBeUndefined()
})

it('keeps every named product beyond four and never merges different products through a common alias', async () => {
  const names = ['iPhone 17e', 'Duo 18', '제품 A', '제품 B', '제품 C', '제품 D']
  const text = `제품 비교: ${names.join(', ')}`
  const span = { start: 0, end: text.length, quote: text }
  const payload = entityResult(await hashText(text))
  payload.items = [{ ...payload.items[0], subtype: 'comparison', title: span, excerpt: span,
    presentation: { heading: '비교 대상', summary: { text, references: [span] }, sections: [], table: null } }]
  payload.entities = names.map((name, i) => ({ key: String(i + 1).repeat(24), name, subtype: 'product', qualifier: '제품',
    aliases: ['제품'], role: 'related', references: [span], links: [{ item_key: payload.items[0].key, references: [span] }] }))
  const session = entitySession()
  if (session.nodes[0].type === 'response') session.nodes[0].data.text = text
  const result = validateStructure(payload, text, payload.text_hash)
  const next = attachInformation(session, 'response_entity', result)
  expect(next.nodes.filter((node) => node.type === 'entity')).toHaveLength(6)
  expect(next.nodes.filter((node) => node.type === 'information')).toHaveLength(1)
  next.nodes.push({ ...structuredClone(next.nodes[0]), id: 'second' })
  expect(attachInformation(next, 'second', result).nodes.filter((node) => node.type === 'entity')).toHaveLength(6)
  expect(Object.keys(ENTITY_KIND_LABELS)).toHaveLength(24)
  for (const subtype of Object.keys(ENTITY_KIND_LABELS) as (keyof typeof ENTITY_KIND_LABELS)[]) {
    payload.entities[0].subtype = subtype
    expect(validateStructure(payload, text, payload.text_hash).entities![0].subtype).toBe(subtype)
  }
})
