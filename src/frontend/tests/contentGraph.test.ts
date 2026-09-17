import { beforeEach, expect, it, vi } from 'vitest'
import {
  attachSources,
  attachInformation,
  hashText,
  markdownLinks,
  validateStructure,
} from '../src/lib/contentGraph'
import type { ResponseNode, Session, StructureResult } from '../src/types'
import { useStore } from '../src/store'
import { saveSession } from '../src/lib/db'

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
  id: 'session-r',
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
  expect(useStore.getState().session!.nodes[0].position).toEqual({ x: 444, y: 555 })
  expect(useStore.getState().session!.viewport).toEqual(initial.viewport)
  await useStore.getState().structure(response.id)
  expect(fetch).toHaveBeenCalledTimes(2)
  await saveSession(useStore.getState().session!)
  useStore.getState().newConversation()
  await useStore.getState().initialize()
  useStore.getState().open(initial.id)
  expect(useStore.getState().session!.nodes).toHaveLength(4)
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('switching records cancels structuring and late results cannot resurrect deleted records', async () => {
  const initial = session()
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
  await useStore.getState().remove(initial.id)
  resolve(new Response(JSON.stringify(await result())))
  await pending
  expect(useStore.getState().session).toBeNull()
  expect(useStore.getState().history).toHaveLength(0)
})
