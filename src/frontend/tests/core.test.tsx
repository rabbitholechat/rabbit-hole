import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { RabbitIcon } from '../src/components/RabbitIcon'
import { Button } from '../src/components/ui/button'
import { layoutPages, CARD_HEIGHT, CARD_WIDTH } from '../src/lib/layout'
import { makeSample } from '../src/lib/samples'
import { saveSession, loadSessions, deleteSession } from '../src/lib/db'
import { useStore } from '../src/store'
import { canvasBounds } from '../src/lib/canvasBounds'
import { safeUrl } from '../src/lib/utils'
import type { Envelope, PageNode } from '../src/types'
import { parseToolSources } from '../src/lib/toolSources'

beforeEach(() => {
  useStore.getState().stop()
  useStore.setState({ session: null, history: [], activeRequest: null, lastSeq: 0 })
})
it('uses one shared profile rabbit and accessible button', () => {
  const click = vi.fn()
  render(
    <Button onClick={click}>
      <RabbitIcon />새 대화
    </Button>,
  )
  fireEvent.click(screen.getByRole('button', { name: '새 대화' }))
  expect(click).toHaveBeenCalledOnce()
})
describe('layout', () => {
  it('has no card overlap and spreads horizontally', () => {
    const sample = makeSample('vector')
    for (const a of sample.nodes)
      for (const b of sample.nodes)
        if (a.id !== b.id) {
          expect(
            Math.abs(a.position.x - b.position.x) >= CARD_WIDTH ||
              Math.abs(a.position.y - b.position.y) >= CARD_HEIGHT,
          ).toBe(true)
        }
    const xs = sample.nodes.map((n) => n.position.x),
      ys = sample.nodes.map((n) => n.position.y)
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(Math.max(...ys) - Math.min(...ys))
  })
  it('keeps every existing dragged position during expansion', () => {
    const sample = makeSample('vector'),
      existing = sample.nodes.filter((n): n is PageNode => n.type === 'page').slice(0, 3)
    existing[0].position = { x: -200, y: 420 }
    const next = layoutPages(sample.sources, existing, sample.graph, existing[0].id)
    for (const old of existing) expect(next.find((n) => n.id === old.id)?.position).toEqual(old.position)
  })
})
it('ignores stale stream events from a previous search', () => {
  const session = { ...makeSample('vector'), mode: 'live' as const }
  useStore.setState({ session, activeRequest: 'current', lastSeq: 0 })
  const event = {
    version: 2,
    request_id: 'old',
    job_id: 'old',
    seq: 10,
    type: 'sources',
    data: { sources: [] },
  } as Envelope
  useStore.getState().receive(event)
  expect(useStore.getState().session).toBe(session)
  expect(useStore.getState().lastSeq).toBe(0)
})
it('never sends sample sources, prices or continuation into real requests', async () => {
  const sample = makeSample('flight')
  useStore.setState({ session: sample, input: 'new real query' })
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ detail: 'keys missing' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }),
  )
  await useStore.getState().run()
  const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
  expect(body.continuation).toBeUndefined()
  expect(body).not.toHaveProperty('sources')
  expect(useStore.getState().session?.mode).toBe('live')
  expect(useStore.getState().session?.sources).toEqual([])
  fetchMock.mockRestore()
})
it('restores positions and viewport from IndexedDB and deletes history', async () => {
  const sample = makeSample('vector')
  sample.viewport = { x: 345, y: -122, zoom: 0.7 }
  sample.sources[0].content_origin = 'web_search_summary'
  await saveSession(sample)
  expect((await loadSessions()).find((s) => s.id === sample.id)?.viewport).toEqual(sample.viewport)
  expect((await loadSessions()).find((s) => s.id === sample.id)?.sources[0].content_origin).toBe(
    'web_search_summary',
  )
  await deleteSession(sample.id)
  expect((await loadSessions()).find((s) => s.id === sample.id)).toBeUndefined()
})
it('blocks unsafe link schemes', () => {
  expect(safeUrl('javascript:alert(1)')).toBeUndefined()
  expect(safeUrl('http://127.0.0.1')).toBeUndefined()
  expect(safeUrl('https://example.com/page')).toBe('https://example.com/page')
})

it('never forwards legacy topic fields when continuing a saved session', async () => {
  const session = {
    ...makeSample('vector'),
    mode: 'live' as const,
    continuation: 'signed-old-session',
    flight: { origin: 'legacy', passengers: 1 },
  }
  useStore.setState({ session, input: '조건 없이 비교해 주세요' })
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ detail: 'test' }), { status: 503 }))
  try {
    await useStore.getState().run()
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    expect(body).not.toHaveProperty('flight')
    expect(body.continuation).toBeUndefined()
    expect(body.query).toBe('조건 없이 비교해 주세요')
  } finally {
    fetchMock.mockRestore()
  }
})

it('shows a diagnostic code when the agent fails', () => {
  useStore.setState({
    session: { ...makeSample('vector'), mode: 'live' },
    activeRequest: 'current',
    lastSeq: 0,
  })
  useStore.getState().receive({
    version: 2,
    request_id: 'current',
    job_id: 'job',
    seq: 1,
    type: 'part_error',
    data: { part: 'response', code: 'timeout', message: '응답 시간이 초과되었습니다.' },
  })
  expect(useStore.getState().error).toBe('응답 시간이 초과되었습니다. [timeout]')
})

it('appends deltas exactly once and preserves node placement on completion and interruption', () => {
  const session = { ...makeSample('vector'), protocol: 2 as const, mode: 'live' as const, nodes: [] }
  useStore.setState({ session, activeRequest: 'r', responseId: null, pendingQuery: 'hello', lastSeq: 0 })
  const send = (seq: number, type: string, data: Record<string, unknown>) =>
    useStore.getState().receive({ version: 2, request_id: 'r', job_id: 'j', seq, type, data })
  send(1, 'response_started', { id: 'response_r' })
  send(2, 'response_delta', { id: 'response_r', delta: '**Hello' })
  send(2, 'response_delta', { id: 'response_r', delta: 'duplicate' })
  send(3, 'response_delta', { id: 'wrong', delta: 'wrong' })
  useStore.getState().nodesChange([{ type: 'position', id: 'response_r', position: { x: 123, y: 234 } }])
  send(4, 'response_delta', { id: 'response_r', delta: '**' })
  const node = useStore.getState().session!.nodes[0]
  expect(node.type === 'response' && node.data.text).toBe('**Hello**')
  send(5, 'done', { status: 'partial', failed_parts: ['response'] })
  const done = useStore.getState().session!.nodes[0]
  expect(done.position).toEqual({ x: 123, y: 234 })
  expect(done.type === 'response' && done.data.status).toBe('partial')
})

it('validates and restores tool sources without moving nodes or fetching history', async () => {
  const sources = [
    {
      id: `src_${'a'.repeat(24)}`,
      url: 'https://example.com/page',
      title: 'Page',
      access: 'search_result' as const,
      verification: 'unverified' as const,
      accessed_at: '2026-09-17T00:00:00+00:00',
    },
  ]
  expect(parseToolSources([{ ...sources[0], verification: 'verified' }])).toBeUndefined()
  expect(parseToolSources([{ ...sources[0], url: 'javascript:alert(1)' }])).toBeUndefined()
  const session = { ...makeSample('vector'), protocol: 2 as const, mode: 'live' as const, nodes: [] }
  useStore.setState({ session, activeRequest: 'r', responseId: null, pendingQuery: 'hello', lastSeq: 0 })
  const send = (seq: number, type: string, data: Record<string, unknown>) =>
    useStore.getState().receive({ version: 2, request_id: 'r', job_id: 'j', seq, type, data })
  send(1, 'response_started', { id: 'response_r' })
  send(2, 'response_completed', { id: 'response_r', text: 'Answer' })
  useStore.getState().nodesChange([{ type: 'position', id: 'response_r', position: { x: 123, y: 234 } }])
  send(3, 'response_sources', { id: 'wrong', sources })
  expect(useStore.getState().session!.nodes[0].data).not.toHaveProperty('toolSources')
  send(4, 'response_sources', { id: 'response_r', sources })
  send(5, 'done', { status: 'completed', failed_parts: [] })
  const saved = useStore.getState().session!
  expect(saved.nodes).toHaveLength(1)
  expect(saved.nodes[0].data).toMatchObject({ text: 'Answer', toolSources: sources })
  expect(saved.nodes[0].position).toEqual({ x: 123, y: 234 })
  await saveSession(saved)
  useStore.setState({ activeRequest: null, session: null })
  const fetchMock = vi.spyOn(globalThis, 'fetch')
  await useStore.getState().initialize()
  useStore.getState().open(saved.id)
  expect(useStore.getState().session!.nodes[0].data).toMatchObject({ toolSources: sources })
  expect(fetchMock).not.toHaveBeenCalled()
  fetchMock.mockRestore()
})

it('retries the latest failed request even when no response node was created', async () => {
  const session = {
    ...makeSample('vector'),
    protocol: 2 as const,
    mode: 'live' as const,
    continuation: 'prior',
    nodes: [],
  }
  useStore.setState({ session, input: '새로운 후속 질문', pendingQuery: '' })
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response(JSON.stringify({ detail: 'unavailable' }), { status: 503 }))
  try {
    await useStore.getState().run()
    await useStore.getState().run({ retry: true })
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string).query).toBe('새로운 후속 질문')
  } finally {
    fetchMock.mockRestore()
  }
})

it('generates a title once without replacing another active conversation', async () => {
  let resolve!: (value: Response) => void
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const session = {
    ...makeSample('vector'),
    protocol: 2 as const,
    mode: 'live' as const,
    nodes: [],
    continuation: 'signed-first',
  }
  useStore.setState({ session, activeRequest: 'r', responseId: null, pendingQuery: 'hello', lastSeq: 0 })
  const send = (seq: number, type: string, data: Record<string, unknown>) =>
    useStore.getState().receive({ version: 2, request_id: 'r', job_id: 'j', seq, type, data })
  send(1, 'response_started', { id: 'response_r' })
  send(2, 'response_completed', { id: 'response_r', text: 'Hello' })
  expect(fetchMock).not.toHaveBeenCalled()
  send(3, 'done', { status: 'completed' })
  send(4, 'done', { status: 'completed' })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock.mock.calls[0][0]).toBe('/api/title')
  const other = makeSample('vector')
  useStore.setState({ session: other, activeRequest: null })
  resolve(new Response(JSON.stringify({ title: '인사 나누기' })))
  await vi.waitFor(() =>
    expect(useStore.getState().history.find((s) => s.id === session.id)?.title).toBe('인사 나누기'),
  )
  expect(useStore.getState().session?.id).toBe(other.id)
  useStore.getState().open(session.id)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  fetchMock.mockRestore()
})

it('branches from the selected response checkpoint and retains that parent when retrying', async () => {
  const session = {
    ...makeSample('vector'),
    protocol: 2 as const,
    mode: 'live' as const,
    continuation: 'after-b',
    nodes: [
      {
        id: 'a',
        type: 'response' as const,
        position: { x: 0, y: 0 },
        width: 560,
        data: {
          prompt: 'A',
          text: 'A answer',
          status: 'completed' as const,
          parentId: null,
          continuation: 'after-a',
        },
      },
      {
        id: 'b',
        type: 'response' as const,
        position: { x: 624, y: 0 },
        width: 560,
        measured: { height: 600 },
        data: {
          prompt: 'B',
          text: 'B answer',
          status: 'completed' as const,
          parentId: 'a',
          continuation: 'after-b',
        },
      },
    ],
  }
  useStore.setState({ session, activeRequest: null, replyTo: null, input: 'A에서 분기' })
  useStore.getState().reply('a')
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const request = JSON.parse(init!.body as string)
    useStore.getState().receive({
      version: 2,
      request_id: request.request_id,
      job_id: 'j',
      seq: 1,
      type: 'response_started',
      data: { id: 'c' },
    })
    return new Response(JSON.stringify({ detail: 'unavailable' }), { status: 503 })
  })
  await useStore.getState().run()
  expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).continuation).toBe('after-a')
  const branch = useStore.getState().session!.nodes.find((n) => n.id === 'c')!
  expect(branch.type === 'response' && branch.data.parentId).toBe('a')
  expect(branch.position).toEqual({ x: 624, y: 664 })
  useStore.getState().toggleResponse('a')
  expect(useStore.getState().session!.nodes.filter((n) => n.type === 'response')[0].data.collapsed).toBe(true)
  fetchMock.mockImplementation(async () => new Response('{}', { status: 503 }))
  await useStore.getState().run({ retry: true })
  expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string).continuation).toBe('after-a')
  expect(useStore.getState().session!.lastParentId).toBe('a')
  fetchMock.mockRestore()
})

it('expands canvas bounds for moved and growing nodes while retaining the current view', () => {
  const screen = { width: 1000, height: 600 }
  expect(canvasBounds([], { x: 500, y: 300, zoom: 1 }, screen)).toEqual([
    [-500, -300],
    [2000, 1300],
  ])
  const node = {
    id: 'far',
    type: 'response' as const,
    position: { x: 4000, y: -2000 },
    measured: { width: 560, height: 1800 },
    data: { prompt: '', text: '', status: 'completed' as const },
  }
  const bounds = canvasBounds([node], { x: 500, y: 300, zoom: 1 }, screen)
  expect(bounds).toEqual([
    [-500, -2300],
    [5060, 1300],
  ])
  const restored = canvasBounds([], { x: -9000, y: -8000, zoom: 0.5 }, screen)
  expect(restored[1][0]).toBeGreaterThanOrEqual(20000)
  expect(restored[1][1]).toBeGreaterThanOrEqual(17200)
})
