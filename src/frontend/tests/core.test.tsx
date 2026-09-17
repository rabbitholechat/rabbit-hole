import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { RabbitIcon } from '../src/components/RabbitIcon'
import { Button } from '../src/components/ui/button'
import { layoutPages, CARD_HEIGHT, CARD_WIDTH } from '../src/lib/layout'
import { makeSample } from '../src/lib/samples'
import { saveSession, loadSessions, deleteSession } from '../src/lib/db'
import { useStore } from '../src/store'
import { safeUrl } from '../src/lib/utils'
import type { Envelope } from '../src/types'

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
      existing = sample.nodes.slice(0, 3)
    existing[0].position = { x: -200, y: 420 }
    const next = layoutPages(sample.sources, existing, sample.graph, existing[0].id)
    for (const old of existing) expect(next.find((n) => n.id === old.id)?.position).toEqual(old.position)
  })
})
it('ignores stale stream events from a previous search', () => {
  const session = { ...makeSample('vector'), mode: 'live' as const }
  useStore.setState({ session, activeRequest: 'current', lastSeq: 0 })
  const event = {
    version: 1,
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
it('rejects nonexistent graph endpoints and deduplicates source events', () => {
  const session = makeSample('vector')
  useStore.setState({ session, activeRequest: 'current', lastSeq: 0 })
  useStore.getState().receive({
    version: 1,
    request_id: 'current',
    job_id: 'job',
    seq: 1,
    type: 'sources',
    data: { sources: session.sources },
  })
  expect(useStore.getState().session?.sources).toHaveLength(6)
  useStore.getState().receive({
    version: 1,
    request_id: 'current',
    job_id: 'job',
    seq: 2,
    type: 'relationships',
    data: { clusters: [], relations: [{ ...session.graph.relations[0], target: 'does_not_exist' }] },
  })
  expect(useStore.getState().session?.graph.relations).toHaveLength(0)
})
it('preserves cards when relation generation fails', () => {
  const session = makeSample('vector')
  useStore.setState({ session, activeRequest: 'current' })
  useStore.getState().receive({
    version: 1,
    request_id: 'current',
    job_id: 'job',
    seq: 1,
    type: 'part_error',
    data: { part: 'relationships', message: 'failed' },
  })
  expect(useStore.getState().session?.nodes).toHaveLength(6)
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
    expect(body.continuation).toBe('signed-old-session')
    expect(body.query).toBe('조건 없이 비교해 주세요')
  } finally {
    fetchMock.mockRestore()
  }
})

it('shows a diagnostic code when a search tool fails', () => {
  useStore.setState({
    session: { ...makeSample('vector'), mode: 'live' },
    activeRequest: 'current',
    lastSeq: 0,
  })
  useStore.getState().receive({
    version: 1,
    request_id: 'current',
    job_id: 'job',
    seq: 1,
    type: 'part_error',
    data: { part: 'search', code: 'timeout', message: '응답 시간이 초과되었습니다.' },
  })
  expect(useStore.getState().error).toBe('응답 시간이 초과되었습니다. [timeout]')
})
