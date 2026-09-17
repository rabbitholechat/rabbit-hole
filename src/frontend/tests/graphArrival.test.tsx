import { StrictMode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Edge } from '@xyflow/react'
import { useGraphArrival } from '../src/hooks/useGraphArrival'
import { useEdgeArrival } from '../src/hooks/useEdgeArrival'
import type { CanvasNode } from '../src/types'

const nodes: CanvasNode[] = [
  { id: 'a', type: 'response', position: { x: 0, y: 0 }, data: { prompt: 'q', text: 'a', status: 'completed' } },
  { id: 'b', type: 'information', position: { x: 600, y: 0 }, data: { entityId: 'b' } },
]
const edge: Edge = { id: 'edge-a-b', source: 'a', target: 'b', type: 'content' }
let motion: MediaQueryList
beforeEach(() => {
  motion = Object.assign(new EventTarget(), { matches: false, media: '(prefers-reduced-motion: reduce)' }) as MediaQueryList
  vi.stubGlobal('matchMedia', () => motion)
})
afterEach(() => vi.unstubAllGlobals())

function graph() {
  return renderHook(({ nodes, edges, restoring }) => useGraphArrival('session', nodes, edges, restoring), {
    initialProps: { nodes: [] as CanvasNode[], edges: [] as Edge[], restoring: false }, wrapper: StrictMode,
  })
}

it('plays once in StrictMode and never replays on geometry changes, remount, or edge label changes', () => {
  const canvas = graph()
  canvas.rerender({ nodes, edges: [edge], restoring: false })
  const arrival = renderHook(({ data }) => useEdgeArrival(data), {
    initialProps: { data: canvas.result.current.edges[0].data }, wrapper: StrictMode,
  })
  expect(arrival.result.current.delay).toBe(210)
  canvas.rerender({ nodes: nodes.map((n) => ({ ...n, position: { x: 55, y: 80 } })), edges: [edge], restoring: false })
  arrival.rerender({ data: canvas.result.current.edges[0].data })
  expect(arrival.result.current.delay).toBe(210)
  act(() => arrival.result.current.finish())
  arrival.rerender({ data: canvas.result.current.edges[0].data })
  expect(arrival.result.current.delay).toBeNull()
  arrival.unmount()
  canvas.rerender({ nodes, edges: [{ ...edge, id: 'updated-label-edge', label: '출처 표기' }], restoring: false })
  const remounted = renderHook(() => useEdgeArrival(canvas.result.current.edges[0].data), { wrapper: StrictMode })
  expect(remounted.result.current.delay).toBeNull()
})

it('does not replay existing or newly fetched edges when restoring the same saved canvas', () => {
  const canvas = graph()
  canvas.rerender({ nodes, edges: [edge], restoring: false })
  canvas.rerender({ nodes, edges: [edge], restoring: true })
  const another = { ...edge, id: 'edge-a-c', target: 'c' }
  canvas.rerender({ nodes, edges: [edge, another], restoring: false })
  const restored = renderHook(() => useEdgeArrival(canvas.result.current.edges[0].data))
  const fetched = renderHook(() => useEdgeArrival(canvas.result.current.edges[1].data))
  expect(restored.result.current.delay).toBeNull()
  expect(fetched.result.current.delay).toBeNull()
})

it('does not replay after disabling and re-enabling motion', () => {
  const canvas = graph()
  canvas.rerender({ nodes, edges: [edge], restoring: false })
  const arrival = renderHook(() => useEdgeArrival(canvas.result.current.edges[0].data), { wrapper: StrictMode })
  expect(arrival.result.current.delay).not.toBeNull()
  act(() => { Object.assign(motion, { matches: true }); motion.dispatchEvent(new Event('change')) })
  expect(arrival.result.current.delay).toBeNull()
  act(() => { Object.assign(motion, { matches: false }); motion.dispatchEvent(new Event('change')) })
  expect(arrival.result.current.delay).toBeNull()
})
