import { expect, it, vi } from 'vitest'
vi.mock('../src/lib/historyApi', async () => {
  const { memoryHistoryApi } = await import('./fixtures/historyApi')
  return { historyApi: memoryHistoryApi() }
})
import { attachInformation, hashText, validateStructure } from '../src/lib/contentGraph'
import { entityAnswer, entityResult, entitySession } from './fixtures/entities'
import { saveSession } from '../src/lib/db'
import { useStore } from '../src/store'

it('shares a qualified entity across cards and later answers without moving existing nodes', async () => {
  const original = entitySession(), payload = entityResult(await hashText(entityAnswer))
  validateStructure(payload, entityAnswer, payload.text_hash)
  const first = attachInformation(original, 'response_entity', payload)
  const hub = first.nodes.find((node) => node.type === 'entity')!
  expect(first.contentGraph!.relations.filter((edge) => edge.target === hub.id)).toHaveLength(2)
  expect(first.nodes.filter((node) => node.type === 'information').every((node) => node.position.x + node.width! < hub.position.x)).toBe(true)
  const second = structuredClone(first)
  second.nodes.push({ ...structuredClone(second.nodes[0]), id: 'response_second', position: { x: 0, y: 1500 } })
  const next = attachInformation(second, 'response_second', payload)
  expect(next.nodes.filter((node) => node.type === 'entity')).toEqual([hub])
  expect(next.contentGraph!.relations.filter((edge) => edge.target === hub.id)).toHaveLength(4)
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
    (value: typeof payload) => { value.entities![0].links[0].references = [{ ...value.entities![0].links[0].references[0], quote: '변조된 원문' }] },
    (value: typeof payload) => { value.entities![0].links[0].item_key = 'f'.repeat(24) },
    (value: typeof payload) => { value.entities![0].links[0].references = value.entities![0].links[1].references },
  ]) {
    const bad = structuredClone(payload)
    mutate(bad)
    const result = validateStructure(bad, entityAnswer, payload.text_hash)
    expect(result.entities).toEqual([])
    expect(result.items).toEqual(payload.items)
  }
})
