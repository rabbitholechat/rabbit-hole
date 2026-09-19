import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('../src/lib/historyApi', async () => {
  const { memoryHistoryApi } = await import('./fixtures/historyApi')
  return { historyApi: memoryHistoryApi() }
})
import { useStore } from '../src/store'
import { attachInformation } from '../src/lib/contentGraph'
import { editLocked, visibleLinks, visibleNodes, nodeDraft } from '../src/lib/canvasEditing'
import { entityResult, entitySession } from './fixtures/entities'
import { previousNodes } from '../src/components/PreviousNodeButton'
import { entityInformation } from '../src/lib/nodeActions'
import type { UserNodeData } from '../src/types'

beforeEach(() => {
  useStore.getState().newConversation()
  const session = attachInformation({ ...entitySession(), id: crypto.randomUUID() }, 'response_entity', entityResult('hash'))
  useStore.setState({ session, history: [], activeRequest: null })
})
it('copies independent nodes, deletes with incident links and undoes without restoring the viewport', () => {
  const store = useStore.getState()
  const original = structuredClone(store.session!)
  store.copyNode('response_entity')
  store.pasteNode({ x: 123, y: 456 })
  let current = useStore.getState().session!
  const copy = current.canvasEdits!.nodes[0]
  expect(copy.data.title).toBe(original.nodes[0].type === 'response' ? original.nodes[0].data.prompt : '')
  expect(copy.position).toEqual({ x: 123, y: 456 })
  expect(visibleLinks(current).some(e => e.source === copy.id || e.target === copy.id)).toBe(false)
  store.deleteNode('response_entity')
  current = useStore.getState().session!
  expect(visibleNodes(current).some(n => n.id === 'response_entity')).toBe(false)
  expect(visibleLinks(current).some(e => e.source === 'response_entity')).toBe(false)
  store.viewport({ x: 9, y: 8, zoom: 1.2 })
  store.undo()
  expect(visibleNodes(useStore.getState().session).some(n => n.id === 'response_entity')).toBe(true)
  expect(useStore.getState().session!.viewport).toEqual({ x: 9, y: 8, zoom: 1.2 })
  store.redo()
  expect(visibleNodes(useStore.getState().session).some(n => n.id === 'response_entity')).toBe(false)
  expect(useStore.getState().session!.nodes).toEqual(original.nodes)
})
it('keeps original evidence and tool metadata immutable through all node types and restoration', async () => {
  const store = useStore.getState()
  const original = structuredClone(store.session!)
  for (const kind of ['response', 'entity', 'information', 'source', 'image'] as const) {
    const data: UserNodeData = { kind, title: '수정 제목', text: '수정 내용', url: 'https://example.com/page', imageUrl: 'https://example.com/image.png' }
    expect(store.saveNode('response_entity', data)).toBe(true)
    expect(nodeDraft(useStore.getState().session!, 'response_entity')).toEqual(data)
  }
  expect(useStore.getState().session!.contentGraph).toEqual(original.contentGraph)
  expect(useStore.getState().session!.nodes).toEqual(original.nodes)
  expect(visibleLinks(useStore.getState().session).filter(e => e.source === 'response_entity').every(e => e.kind === 'manual')).toBe(true)
  const edits = structuredClone(useStore.getState().session!.canvasEdits)
  const fetch = vi.spyOn(globalThis, 'fetch')
  await store.open(original.id)
  expect(useStore.getState().session!.canvasEdits).toEqual(edits)
  expect(useStore.getState().undoStack).toEqual([])
  expect(fetch).not.toHaveBeenCalled()
  fetch.mockRestore()
})
it('uses actual visible edges for previous and related information navigation', () => {
  const store = useStore.getState()
  const hub = store.session!.nodes.find(n => n.type === 'entity')!
  const cards = entityInformation(store.session, hub.id)
  for (const link of visibleLinks(store.session).filter(e => e.source === hub.id)) store.deleteEdge(link.id)
  expect(entityInformation(useStore.getState().session, hub.id)).toEqual([])
  expect(previousNodes(useStore.getState().session, cards[0].id)).toEqual([])
  store.undo()
  expect(entityInformation(useStore.getState().session, hub.id)).toHaveLength(1)
  const edge = visibleLinks(useStore.getState().session).find(e => e.source === hub.id)!
  store.saveEdge({ ...edge, source: cards[0].id, label: '직접 연결' })
  expect(visibleLinks(useStore.getState().session).find(e => e.id === edge.id)).toMatchObject({ source: cards[0].id, label: '직접 연결', kind: 'manual' })
  expect(previousNodes(useStore.getState().session, edge.target).map(n => n.id)).toEqual([cards[0].id])
})
it('rejects unsafe URLs and blocks mutation during generation; movement is undoable', () => {
  const store = useStore.getState()
  const draft = nodeDraft(store.session!, 'response_entity')!
  expect(store.saveNode('response_entity', { ...draft, kind: 'source', url: 'javascript:alert(1)' })).toBe(false)
  store.nodesChange([{ type: 'position', id: 'response_entity', position: { x: 900, y: 500 }, dragging: true }])
  store.nodesChange([{ type: 'position', id: 'response_entity', position: { x: 950, y: 500 }, dragging: false }])
  store.nodesChange([{ type: 'position', id: 'response_entity', position: { x: 950, y: 500 }, dragging: false }])
  expect(useStore.getState().undoStack).toHaveLength(1)
  store.undo()
  expect(visibleNodes(useStore.getState().session)[0].position).toEqual({ x: 0, y: 0 })
  expect(useStore.getState().session!.nodes[0].position).toEqual({ x: 0, y: 0 })
  store.copyNode('response_entity')
  useStore.setState(s => ({ session: { ...s.session!, status: 'running' } }))
  expect(editLocked(useStore.getState().session)).toBe(true)
  store.deleteNode('response_entity'); store.pasteNode(); store.redo()
  expect(visibleNodes(useStore.getState().session)).toHaveLength(store.session!.nodes.length)
})
