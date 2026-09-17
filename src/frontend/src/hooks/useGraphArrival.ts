import { useRef, type CSSProperties } from 'react'
import type { Edge } from '@xyflow/react'
import type { CanvasNode } from '../types'

// Presentation-only state: never persisted or replayed when a saved canvas opens.
export function useGraphArrival(sessionId: string | undefined, nodes: CanvasNode[], edges: Edge[]) {
  const timeline = useRef<{
    sessionId?: string
    nodes: Map<string, number | null>
    edges: Map<string, number | null>
  }>({ nodes: new Map(), edges: new Map() })
  if (timeline.current.sessionId !== sessionId) {
    timeline.current = {
      sessionId,
      nodes: new Map(nodes.map((node) => [node.id, null])),
      edges: new Map(edges.map((edge) => [edge.id, null])),
    }
  }
  const seen = timeline.current
  let order = 0
  for (const node of nodes) {
    if (!seen.nodes.has(node.id)) {
      seen.nodes.set(node.id, Math.min(order++, 4) * 90)
    }
  }
  for (const edge of edges) {
    if (!seen.edges.has(edge.id)) {
      seen.edges.set(edge.id, Math.max(seen.nodes.get(edge.source) ?? 0, seen.nodes.get(edge.target) ?? 0) + 120)
    }
  }
  return {
    nodes: nodes.map((node) => {
      const delay = seen.nodes.get(node.id)
      if (delay == null || !['information', 'source'].includes(node.type!)) return node
      return {
        ...node,
        className: [node.className, 'node-arriving'].filter(Boolean).join(' '),
        style: { ...node.style, '--arrival-delay': `${delay}ms` } as CSSProperties,
      }
    }),
    edges: edges.map((edge) => ({
      ...edge,
      data: { ...edge.data, arrivalDelay: seen.edges.get(edge.id) },
    })),
  }
}
