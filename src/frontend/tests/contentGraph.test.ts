vi.mock('../src/lib/historyApi', async () => {
  const { memoryHistoryApi } = await import('./fixtures/historyApi')
  return { historyApi: memoryHistoryApi() }
})
import { parseToolSources } from '../src/lib/toolSources'
import { responseParentId } from '../src/lib/nodeActions'
import { previousNodes } from '../src/components/PreviousNodeButton'
import { beforeEach, expect, it, vi } from 'vitest'
import {
  attachSources,
  deduplicateSources,
  attachInformation,
  hashText,
  markdownLinks,
  validateStructure,
} from '../src/lib/contentGraph'
import type { ResponseNode, Session, StructureResult } from '../src/types'
import { useStore } from '../src/store'
import { saveSession } from '../src/lib/db'
import { startResponseTiming } from '../src/lib/responseTiming'

const excerpt =
  '벡터 검색은 의미를 비교합니다. 단, 도메인에 따라 정확도가 달라집니다. [자료](https://example.com/a)'
const text = `🐇 원래 답변\n\n${excerpt}\n\n${'추가 설명을 보존합니다. '.repeat(10)}`
const response: ResponseNode = {
  id: 'response_r',
  type: 'response',
  position: { x: 120, y: 150 },
  width: 560,
  data: {
    prompt: '질문',
    text,
    status: 'completed',
    continuation: 'signed',
    toolSources: [
      {
        id: `src_${'a'.repeat(24)}`,
        url: 'https://example.com/a',
        title: '자료 A',
        access: 'search_result',
        verification: 'unverified',
        accessed_at: '2026-09-17T00:00:00Z',
      },
      {
        id: `src_${'b'.repeat(24)}`,
        url: 'https://example.com/b',
        title: '자료 B',
        access: 'page_read',
        verification: 'unverified',
        accessed_at: '2026-09-17T00:00:00Z',
      },
    ],
  },
}
const session = (): Session => ({
  id: crypto.randomUUID(),
  query: '질문',
  updatedAt: 1,
  mode: 'live',
  protocol: 2,
  nodes: [structuredClone(response)],
  sources: [],
  graph: { relations: [], clusters: [] },
  answer: null,
  viewport: { x: 77, y: -91, zoom: 0.8 },
  fitted: true,
  pinned: ['response_r'],
  status: 'completed',
  failedParts: [],
})
async function result(): Promise<StructureResult> {
  const start = Array.from(text.slice(0, text.indexOf(excerpt))).length
  return {
    version: 1,
    text_hash: await hashText(text),
    items: [
      {
        key: 'c'.repeat(24),
        subtype: 'concept',
        title: { start, end: start + 5, quote: '벡터 검색' },
        excerpt: { start, end: start + Array.from(excerpt).length, quote: excerpt },
      },
    ],
  }
}
beforeEach(() => {
  useStore.getState().newConversation()
  useStore.setState({ history: [], session: null })
  vi.restoreAllMocks()
})

it('sources are page-level nodes with retrieval/citation edges and no relocation on replay', () => {
  const original = session()
  const next = attachSources(original, response.id)
  expect(next.nodes).toHaveLength(3)
  expect(next.nodes[1].position.x - response.position.x - response.width!).toBe(88)
  expect(next.contentGraph!.relations.map((r) => r.kind)).toEqual(['cites', 'consulted'])
  next.nodes[1].position = { x: 2500, y: 3500 }
  const again = attachSources(next, response.id)
  expect(again.nodes).toEqual(next.nodes)
  expect(again.contentGraph!.relations).toHaveLength(2)
  expect(again.nodes[0]).toEqual(original.nodes[0])
  expect(again.viewport).toEqual(original.viewport)
  const noSources = session()
  ;(noSources.nodes[0] as ResponseNode).data.toolSources = []
  expect(attachSources(noSources, response.id).nodes).toHaveLength(1)
})

it('code links do not become citations; reference links resolve to their exact original span', () => {
  const links = markdownLinks(
    '`[fake](https://example.com/fake)`\n\n```md\nhttps://example.com/code\n```\n\n🐇 [문서][ref]\n\n[ref]: https://example.com/a',
  )
  expect(links).toHaveLength(1)
  expect(links[0].span.quote).toBe('[문서][ref]')
})

it('information validates Unicode spans, rejects fabrication and deduplicates insertion', async () => {
  const payload = await result()
  expect(validateStructure(payload, text, payload.text_hash)).toEqual(payload)
  expect(() => validateStructure({ ...payload, text_hash: 'wrong' }, text, payload.text_hash)).toThrow()
  const invalid = structuredClone(payload)
  invalid.items[0].excerpt.quote = 'invented'
  expect(() => validateStructure(invalid, text, payload.text_hash)).toThrow()
  const next = attachInformation(attachSources(session(), response.id), response.id, payload)
  expect(next.nodes).toHaveLength(4)
  expect(next.contentGraph!.relations.filter((r) => r.kind === 'has_extract')).toHaveLength(1)
  expect(
    next.contentGraph!.relations.filter((r) => r.source.startsWith('info_') && r.kind === 'cites'),
  ).toHaveLength(1)
  expect(attachInformation(next, response.id, payload).nodes).toEqual(next.nodes)
})

it('information resolves reference citations defined outside its excerpt', async () => {
  const original = session()
  const excerpt = '벡터 검색은 의미를 비교합니다. [문서][ref]'
  const body = `🐇 원래 답변\n\n${excerpt}\n\n[ref]: https://example.com/a`
  ;(original.nodes[0] as ResponseNode).data.text = body
  const start = Array.from(body.slice(0, body.indexOf(excerpt))).length
  const payload: StructureResult = {
    version: 1, text_hash: await hashText(body), items: [{
      key: 'e'.repeat(24), subtype: 'concept',
      title: { start, end: start + 5, quote: '벡터 검색' },
      excerpt: { start, end: start + Array.from(excerpt).length, quote: excerpt },
    }],
  }
  const next = attachInformation(attachSources(original, response.id), response.id, payload)
  const citation = next.contentGraph!.relations.find((r) => r.source.startsWith('info_') && r.kind === 'cites')
  expect(citation?.spans[0].quote).toBe('[문서][ref]')
  expect(Array.from(body).slice(citation!.spans[0].start, citation!.spans[0].end).join('')).toBe('[문서][ref]')
})

it('failure preserves answers and sources; retry commits atomically at latest positions', async () => {
  const initial = attachSources(session(), response.id)
  initial.responseTimings = { original: { ...startResponseTiming('original'), responseId: response.id } }
  useStore.setState({ session: initial, history: [initial] })
  const payload = await result()
  let resolve!: (response: Response) => void
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValueOnce(Error('failed'))
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
  await useStore.getState().structure(response.id)
  expect(useStore.getState().session!.contentGraph!.jobs[response.id].status).toBe('failed')
  const failedTiming = useStore.getState().session!.responseTimings!.original
  expect(failedTiming.status).toBe('failed')
  expect(failedTiming.durationMs).toBeGreaterThanOrEqual(0)
  expect(useStore.getState().session!.nodes).toHaveLength(3)
  const pending = useStore.getState().structure(response.id)
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  await useStore.getState().structure(response.id)
  useStore
    .getState()
    .nodesChange([{ type: 'position', id: response.id, position: { x: 444, y: 555 }, dragging: false }])
  resolve(new Response(JSON.stringify(payload)))
  await pending
  expect(useStore.getState().session!.nodes).toHaveLength(4)
  expect(useStore.getState().session!.responseTimings!.original).toEqual(failedTiming)
  expect(useStore.getState().session!.nodes[0].position).toEqual({ x: 444, y: 555 })
  expect(useStore.getState().session!.viewport).toEqual(initial.viewport)
  await useStore.getState().structure(response.id)
  expect(fetch).toHaveBeenCalledTimes(2)
  await saveSession(useStore.getState().session!)
  useStore.getState().newConversation()
  await useStore.getState().initialize()
  await useStore.getState().open(initial.id)
  expect(useStore.getState().session!.nodes).toHaveLength(4)
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('switching records preserves structuring and deletion rejects late results', async () => {
  const initial = session()
  initial.responseTimings = { switching: { ...startResponseTiming('switching'), responseId: response.id } }
  useStore.setState({ session: initial, history: [initial] })
  let resolve!: (response: Response) => void
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const pending = useStore.getState().structure(response.id)
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  useStore.getState().newConversation()
  expect(useStore.getState().history.find((item) => item.id === initial.id)?.responseTimings?.switching.status).toBe('running')
  await useStore.getState().remove(initial.id)
  expect((fetch.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true)
  resolve(new Response(JSON.stringify(await result())))
  await pending
  expect(useStore.getState().session).toBeNull()
  expect(useStore.getState().history).toHaveLength(0)
})

it('same page variants reuse one card across responses while real query values remain distinct', () => {
  const initial = session()
  const first = initial.nodes[0] as ResponseNode
  const a = first.data.toolSources![0]
  first.data.toolSources = [a, { ...a, id: 'alias_a', url: `${a.url}?utm_source=test#part`, access: 'page_read' },
    { ...a, id: 'different', url: `${a.url}?id=2&lang=ko` },
    { ...a, id: 'same_query', url: `${a.url}?lang=ko&id=2&utm_source=chatgpt` }]
  let next = attachSources(initial, first.id)
  expect(next.nodes.filter((n) => n.type === 'source')).toHaveLength(2)
  next.nodes[1].position = { x: 3333, y: 4444 }
  const followup: ResponseNode = { ...structuredClone(first), id: 'response_next', data: {
    ...first.data, parentId: first.id, toolSources: [{ ...a, id: 'alias_b', url: `${a.url}?gclid=abc&srsltid=xyz` }],
  } }
  next = attachSources({ ...next, nodes: [...next.nodes, followup] }, followup.id)
  expect(next.nodes.filter((n) => n.type === 'source')).toHaveLength(2)
  expect(next.nodes[1].position).toEqual({ x: 3333, y: 4444 })
  const entity = next.contentGraph!.entities[a.id]
  expect(entity.type === 'source' && entity.source.access).toBe('page_read')
  expect(entity.type === 'source' && entity.observations).toHaveLength(2)
  expect(previousNodes(next, followup.id).map((n) => n.id)).toEqual([first.id])
  expect(previousNodes(next, a.id).map((n) => n.id)).toEqual([first.id, followup.id])
  expect(previousNodes(next, first.id)).toEqual([])
})

it('saved duplicate cards merge observations and incoming edges without moving the survivor', async () => {
  const next = attachInformation(attachSources(session(), response.id), response.id, await result())
  const id = response.data.toolSources![0].id
  const source = next.contentGraph!.entities[id]
  if (source.type !== 'source') throw Error('fixture')
  const alias = 'duplicate_source'
  next.contentGraph!.entities[alias] = { ...source, id: alias, source: { ...source.source, id: alias, url: source.source.url + '?utm_campaign=test' } }
  next.nodes.push({ id: alias, type: 'source', position: { x: 9999, y: 8888 }, data: { entityId: alias } })
  next.contentGraph!.relations.push({ id: 'old_edge', source: response.id, target: alias, kind: 'consulted', responseId: response.id, spans: [] })
  next.pinned.push(alias)
  const merged = deduplicateSources(next)
  expect(merged.nodes).toEqual(next.nodes.filter((n) => n.id !== alias))
  expect(merged.pinned).toContain(id)
  expect(merged.contentGraph!.entities[alias]).toBeUndefined()
  expect(merged.contentGraph!.relations.filter((e) => e.source === response.id && e.target === id)).toHaveLength(1)
  expect(merged.contentGraph!.relations.some((e) => e.target === alias)).toBe(false)
  expect(deduplicateSources(merged)).toEqual(merged)
  await saveSession(next)
  const fetch = vi.spyOn(globalThis, 'fetch')
  await useStore.getState().initialize()
  await useStore.getState().open(next.id)
  expect(useStore.getState().session!.nodes.some((n) => n.id === alias)).toBe(false)
  fetch.mock.calls.forEach(() => { throw Error('restore must not call API') })
})

it('selected information is sent as context and linked without replacing the question', async () => {
  const next = attachInformation(attachSources(session(), response.id), response.id, await result())
  next.continuation = 'signed'
  useStore.setState({ session: next, history: [next] })
  const info = next.nodes.find((n) => n.type === 'information')!
  useStore.getState().toggleNode(info.id)
  expect((useStore.getState().session!.nodes.find((n) => n.id === info.id)?.data as { collapsed?: boolean }).collapsed).toBe(true)
  useStore.getState().toggleNode(info.id)
  expect((useStore.getState().session!.nodes.find((n) => n.id === info.id)?.data as { collapsed?: boolean }).collapsed).toBe(false)
  useStore.getState().reply(info.id)
  useStore.getState().setInput('자세히 설명해줘')
  let resolve!: (response: Response) => void
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((done) => { resolve = done }))
  const pending = useStore.getState().run()
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  const payload = JSON.parse(fetch.mock.calls[0][1]!.body as string)
  expect(payload.query).toBe('자세히 설명해줘')
  expect(payload.node_context.text).toBe(excerpt)
  expect(payload.continuation).toBe('signed')
  const id = `response_${payload.request_id}`
  useStore.getState().receive({ version: 2, request_id: payload.request_id, job_id: 'j', seq: 1,
    type: 'response_started', data: { id } })
  expect(useStore.getState().session!.contentGraph!.relations).toContainEqual({
    id: `uses_context:${id}:${info.id}`, source: id, target: info.id, kind: 'uses_context', responseId: id, spans: [],
  })
  const created = useStore.getState().session!.nodes.find((n) => n.id === id) as ResponseNode
  expect(created.data.parentId).toBe(info.id)
  expect(created.position.x).toBe(info.position.x + info.width! + 64)
  expect(previousNodes(useStore.getState().session!, id).map((n) => n.id)).toEqual([info.id])
  resolve(new Response(''))
  await pending
  const saved = useStore.getState().session!
  // Existing faulty records can recover the selected node from their explicit context edge.
  created.data.parentId = response.id
  expect(responseParentId(saved, created)).toBe(info.id)
  await saveSession({ ...saved, id: 'legacy-followup' })
  await useStore.getState().initialize()
  await useStore.getState().open('legacy-followup')
  expect(previousNodes(useStore.getState().session!, id).map((n) => n.id)).toEqual([info.id])
})

it('restoring an interrupted source lookup clears its spinner without fetching again', async () => {
  let saved = session()
  saved.id = 'interrupted-source-lookup'
  saved.status = 'running'
  const node = saved.nodes[0] as ResponseNode
  node.data.toolSources = [{
    ...node.data.toolSources![0],
    content: { status: 'reading', text: '', truncated: false, final_url: null, error_code: null },
  }]
  saved = attachSources(saved, node.id)
  await saveSession(saved)
  const request = vi.spyOn(globalThis, 'fetch')
  await useStore.getState().initialize()
  const restored = useStore.getState().history.find((s) => s.id === saved.id)!
  const source = restored.contentGraph!.entities[node.data.toolSources[0].id]
  expect(source.type === 'source' && source.source.content?.status).toBe('cancelled')
  expect(request).not.toHaveBeenCalled()
})

it('page images remain separate from summaries and connect beside their source on replay', () => {
  const original = session()
  const responseNode = original.nodes[0] as ResponseNode
  const source = responseNode.data.toolSources![0]
  source.page_image = { thumbnail_url: 'https://example.com/photo.jpg' }
  responseNode.data.toolSources = parseToolSources(responseNode.data.toolSources)!
  const next = attachSources(original, responseNode.id)
  const page = next.nodes.find((n) => n.id === source.id)!
  const image = next.nodes.find((n) => n.id === `image_${source.id}`)!
  expect(image.position.x).toBeGreaterThan(page.position.x + page.width!)
  expect(image.position.y).toBe(page.position.y)
  expect(next.contentGraph!.relations).toContainEqual(expect.objectContaining({
    source: page.id, target: image.id, kind: 'related_image',
  }))
  const restored = attachSources(deduplicateSources(next), responseNode.id)
  expect(restored.nodes).toEqual(next.nodes)
  expect(restored.contentGraph!.entities[page.id]).toBeDefined()
  expect(restored.contentGraph!.entities[image.id]).toBeDefined()
})

it('v2 cards preserve field references and only cite links in the selected passages', async () => {
  const { structuredAnswer, structuredResult } = await import('./fixtures/information')
  const { nodeText, nodeLabel, nodeContext } = await import('../src/lib/nodeActions')
  const original = session()
  const answer = original.nodes[0] as ResponseNode
  answer.data.text = structuredAnswer
  answer.data.toolSources!.push({ ...answer.data.toolSources![0], id: `src_${'f'.repeat(24)}`, url: 'https://example.com/unrelated' })
  const payload = structuredResult(await hashText(structuredAnswer))
  validateStructure(payload, structuredAnswer, payload.text_hash)
  const next = attachInformation(attachSources(original, answer.id), answer.id, payload)
  const id = `info_${answer.id}_${'d'.repeat(24)}`
  expect(nodeLabel(next, id)).toBe('A와 B의 차이')
  expect(nodeText(next, id)).toContain('설치·설정 | 설치가 간단함 | 초기 설정이 복잡함')
  expect(nodeContext(next, id)?.text).toBe(nodeText(next, id))
  expect(next.nodes.find((node) => node.id === id)?.width).toBe(460)
  expect(next.contentGraph!.relations.filter((edge) => edge.source === id && edge.kind === 'cites').map((edge) => edge.target)).toEqual([
    `src_${'a'.repeat(24)}`, `src_${'b'.repeat(24)}`,
  ])
  expect(next.viewport).toEqual(original.viewport)
  expect(attachInformation(next, answer.id, payload).nodes).toEqual(next.nodes)
  await saveSession(next)
  const { loadSession } = await import('../src/lib/db')
  const restored = await loadSession(next.id)
  expect(restored?.contentGraph?.entities[id]).toEqual(next.contentGraph!.entities[id])
})

it('v2 rejects fabricated references, missing presentation and malformed tables atomically', async () => {
  const { structuredAnswer, structuredResult } = await import('./fixtures/information')
  const payload = structuredResult(await hashText(structuredAnswer))
  const invalidReference = structuredClone(payload)
  invalidReference.items[1].presentation!.sections[0].items[0].references[0].quote = '만들어낸 원문'
  const invalidTable = structuredClone(payload)
  invalidTable.items[0].presentation!.table!.rows[0].pop()
  const missing = structuredClone(payload)
  delete missing.items[1].presentation
  const ungrounded = structuredClone(payload)
  ungrounded.items[0].presentation!.table!.columns[0].references = []
  for (const bad of [invalidReference, invalidTable, missing, ungrounded]) {
    expect(() => validateStructure(bad, structuredAnswer, payload.text_hash)).toThrow('invalid_structure')
  }
  const allowedMissingCell = structuredClone(payload)
  allowedMissingCell.items[0].presentation!.table!.rows[0][1] = null
  expect(validateStructure(allowedMissingCell, structuredAnswer, payload.text_hash)).toEqual(allowedMissingCell)
})

it('short answers now reach independent structuring and may return no cards', async () => {
  const initial = session()
  initial.responseTimings = { short: { ...startResponseTiming('short'), responseId: response.id } }
  const answer = initial.nodes[0] as ResponseNode
  answer.data.text = 'A는 쉽고 B는 복잡합니다.'
  useStore.setState({ session: initial, history: [initial] })
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    version: 2, text_hash: await hashText(answer.data.text), items: [],
  })))
  await useStore.getState().structure(answer.id)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(useStore.getState().session!.contentGraph!.jobs[answer.id].status).toBe('completed')
  expect(useStore.getState().session!.responseTimings!.short.status).toBe('completed')
  expect(useStore.getState().session!.nodes).toEqual(initial.nodes)
})
