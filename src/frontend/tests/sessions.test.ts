import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { Session, Envelope } from '../src/types'

const saved = vi.hoisted(() => new Map<string, Session>())
vi.mock('../src/lib/db', () => ({
  saveSession: vi.fn(async (session: Session) => { saved.set(session.id, structuredClone(session)) }),
  loadSession: vi.fn(async (id: string) => structuredClone(saved.get(id)!)),
  loadSessions: vi.fn(async () => [...saved.values()].map(s => structuredClone(s))),
  deleteSession: vi.fn(async (id: string) => { saved.delete(id) }),
}))
import { useStore } from '../src/store'
import { loadSession } from '../src/lib/db'

const pending: Promise<void>[] = []
beforeEach(() => {
  saved.clear()
  useStore.setState({ session: null, history: [], activeRequest: null, input: '', draftAttachments: [] })
})
afterEach(async () => {
  for (const session of useStore.getState().history) {
    await useStore.getState().open(session.id)
    useStore.getState().stop()
  }
  await Promise.all(pending.splice(0))
  vi.restoreAllMocks()
})
function streamingFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    if (options?.method === 'DELETE') return new Response(null, { status: 204 })
    return new Response(new ReadableStream({ start(controller) {
      options?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
    } }), { headers: { 'content-type': 'text/event-stream' } })
  })
}
function start(query: string) {
  useStore.getState().newConversation()
  useStore.getState().setInput(query)
  pending.push(useStore.getState().run())
  const { session, activeRequest } = useStore.getState()
  let seq = 0
  const id = `response_${activeRequest}`
  return { sessionId: session!.id, requestId: activeRequest!, id,
    send(type: Envelope['type'], data: Record<string, unknown>) {
      useStore.getState().receive({ version: 2, request_id: activeRequest!, job_id: activeRequest!, seq: ++seq, type, data } as Envelope)
    },
  }
}
it('retains every background delta and restores a running session without losing its viewport or stopping another job', async () => {
  streamingFetch()
  const first = start('첫 대화')
  first.send('response_started', { id: first.id })
  useStore.getState().viewport({ x: 100, y: -90, zoom: 0.7 })
  const second = start('둘째 대화')
  second.send('response_started', { id: second.id })
  first.send('response_delta', { id: first.id, delta: '첫 ' })
  first.send('response_delta', { id: first.id, delta: '답변' })
  second.send('response_delta', { id: second.id, delta: '둘째 답변' })
  const getCalls = vi.mocked(loadSession).mock.calls.length
  await useStore.getState().open(first.sessionId)
  expect(vi.mocked(loadSession).mock.calls.length).toBe(getCalls)
  expect(useStore.getState().session).toMatchObject({ status: 'running', viewport: { x: 100, y: -90, zoom: 0.7 } })
  expect(useStore.getState().session!.nodes[0].data).toMatchObject({ text: '첫 답변', status: 'streaming' })
  expect(useStore.getState().activeRequest).toBe(first.requestId)
  useStore.getState().stop()
  await useStore.getState().open(second.sessionId)
  expect(useStore.getState().session!.nodes[0].data).toMatchObject({ text: '둘째 답변', status: 'streaming' })
  expect(useStore.getState().session!.status).toBe('running')
  expect(useStore.getState().activeRequest).toBe(second.requestId)
})
it('structures a completed background answer and keeps structure work alive across navigation', async () => {
  streamingFetch()
  const structure = vi.spyOn(useStore.getState(), 'structure')
  const first = start('첫 대화')
  first.send('response_started', { id: first.id })
  start('둘째 대화')
  // Empty text needs no external structured call and still follows the full lifecycle.
  first.send('response_completed', { id: first.id, text: '' })
  first.send('done', { status: 'completed' })
  expect(structure).toHaveBeenCalledWith(first.id, first.sessionId)
  await useStore.getState().open(first.sessionId)
  useStore.getState().newConversation()
  await vi.waitFor(() => expect(useStore.getState().history.find(s => s.id === first.sessionId)?.contentGraph?.jobs[first.id].status).toBe('completed'))
  expect(useStore.getState().session).toBeNull()
})
it('restores an interrupted persisted session without showing ongoing generation or issuing paid calls', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
  const id = crypto.randomUUID()
  saved.set(id, { id, query: '이전 요청', updatedAt: 1, mode: 'live', protocol: 2, status: 'running',
    nodes: [], sources: [], graph: { relations: [], clusters: [] }, answer: null,
    viewport: { x: 0, y: 0, zoom: 1 }, fitted: false, pinned: [], failedParts: [],
  })
  await useStore.getState().initialize()
  await useStore.getState().open(id)
  expect(useStore.getState().session!.status).toBe('partial')
  expect(useStore.getState().activeRequest).toBeNull()
  expect(fetch).not.toHaveBeenCalled()
})
