import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openDB } from 'idb'
import { loadSessions, loadSession, saveSession, deleteSession } from '../src/lib/db'
import { makeSample } from './fixtures/legacySamples'
import { memoryHistoryApi } from './fixtures/historyApi'

beforeEach(async () => {
  const db = await openDB('rabbit-hole', 1, { upgrade(db) { db.createObjectStore('sessions', { keyPath: 'id' }) } })
  await db.clear('sessions')
  db.close()
})
afterEach(() => vi.restoreAllMocks())

function server() {
  const api = memoryHistoryApi()
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'https://example.com')
    const id = url.pathname.split('/')[3]
    try {
      const result = init?.method === 'PUT' ? await api.save(id, JSON.parse(init.body as string))
        : init?.method === 'POST' ? await api.import(JSON.parse(init.body as string))
        : init?.method === 'DELETE' ? await api.delete(id, Number(url.searchParams.get('revision')))
        : id ? await api.get(id) : await api.list()
      return new Response(result === undefined ? null : JSON.stringify(result), { status: result === undefined ? 204 : 200 })
    } catch {
      return new Response('{}', { status: 409 })
    }
  })
  return { api, fetch }
}

it('uses server revisions and serializes snapshots; restores exact positions without model calls', async () => {
  const { fetch } = server()
  await loadSessions()
  const session = makeSample('vector')
  await Promise.all([saveSession(session), saveSession({ ...session, viewport: { x: 5, y: -20, zoom: .8 } })])
  const [restored] = await loadSessions()
  expect(restored.nodes).toEqual(JSON.parse(JSON.stringify(session.nodes)))
  expect(restored.viewport).toEqual({ x: 5, y: -20, zoom: .8 })
  const writes = fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')
  expect(writes.map(([, init]) => JSON.parse(init!.body as string).revision)).toEqual([0, 1])
  await deleteSession(session.id)
  expect(await loadSessions()).toEqual([])
  expect(fetch.mock.calls.every(([url]) => String(url).startsWith('/api/sessions'))).toBe(true)
})

it('retains legacy originals and retries failed migration, then never reimports a deleted record', async () => {
  const { api, fetch } = server()
  const session = makeSample('vector')
  const db = await openDB('rabbit-hole', 1)
  await db.put('sessions', session)
  fetch.mockResolvedValueOnce(new Response('{}', { status: 503 }))
  const warning = vi.fn()
  expect(await loadSessions(warning)).toEqual([])
  expect(warning).toHaveBeenCalledOnce()
  expect(await db.get('sessions', session.id)).toEqual(session)
  expect(await loadSessions()).toEqual(JSON.parse(JSON.stringify([session])))
  expect((await db.get('sessions', session.id)).__postgresMigrated).toBe(true)
  await deleteSession(session.id)
  expect(await loadSessions()).toEqual([])
  expect(await api.list()).toEqual({ sessions: [] })
  expect(await db.get('sessions', session.id)).toMatchObject(session)
  db.close()
})

it('rejects stale browser writes and deletions without overwriting another browser', async () => {
  const { api } = server()
  const session = makeSample('vector')
  await loadSessions()
  await saveSession(session)
  await api.save(session.id, { session: { ...session, title: 'other browser' }, revision: 1 })
  await expect(saveSession({ ...session, title: 'stale' })).rejects.toThrow('다른 화면')
  await expect(deleteSession(session.id)).rejects.toThrow('다른 화면')
  expect((await api.list()).sessions[0].session.title).toBe('other browser')
})

it('reports unavailable storage and oversized records instead of falling back to IndexedDB', async () => {
  const { fetch } = server()
  await loadSessions()
  fetch.mockResolvedValueOnce(new Response('{}', { status: 413 }))
  await expect(saveSession(makeSample('vector'))).rejects.toThrow('용량 제한')
  fetch.mockRejectedValueOnce(Error('offline'))
  await expect(loadSessions()).rejects.toThrow('offline')
  const db = await openDB('rabbit-hole', 1)
  expect(await db.getAll('sessions')).toEqual([])
  db.close()
})


it('loads all server pages before publishing revisions and chronological history', async () => {
  const { fetch } = server()
  const first = { ...makeSample('vector'), id: 'first', updatedAt: 1 }
  const last = { ...makeSample('vector'), id: 'last', updatedAt: 2 }
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ sessions: [{ session: first, revision: 3 }], next_cursor: 'first' })))
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ sessions: [{ session: last, revision: 7 }] })))
  expect((await loadSessions()).map((s) => s.id)).toEqual(['last', 'first'])
  expect(fetch.mock.calls[1][0]).toBe('/api/sessions?cursor=first')
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ revision: 8 })))
  await saveSession(last)
  expect(JSON.parse(fetch.mock.calls[2][1]!.body as string).revision).toBe(7)
})


it('fetches current content and revision when a conversation is opened', async () => {
  const { api } = server()
  await loadSessions()
  const session = makeSample('vector')
  await saveSession(session)
  await api.save(session.id, { session: { ...session, title: '최신 제목' }, revision: 1 })
  const latest = await loadSession(session.id)
  expect(latest.title).toBe('최신 제목')
  await saveSession(latest)
  expect((await api.get(session.id)).revision).toBe(3)
})
