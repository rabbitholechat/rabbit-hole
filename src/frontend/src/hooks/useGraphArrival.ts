import { useRef, type CSSProperties } from 'react'
import type { Edge } from '@xyflow/react'
import type { EdgeArrival } from './useEdgeArrival'
import type { CanvasNode } from '../types'

const connectionKey = (edge: Edge) => JSON.stringify([edge.type, edge.source, edge.target])

// Presentation-only state: never persisted or replayed when a saved canvas opens.
export function useGraphArrival(sessionId: string | undefined, nodes: CanvasNode[], edges: Edge[], restoring = false) {
  const timeline = useRef<{
    sessionId?: string
    restoring?: boolean
    nodes: Map<string, number | null>
    edges: Map<string, EdgeArrival | undefined>
  }>({ nodes: new Map(), edges: new Map() })
  if (timeline.current.sessionId !== sessionId || restoring || timeline.current.restoring) {
    timeline.current = {
      sessionId,
      restoring,
      nodes: new Map(nodes.map((node) => [node.id, null])),
      edges: new Map(edges.map((edge) => [connectionKey(edge), undefined])),
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
    const key = connectionKey(edge)
    if (!seen.edges.has(key)) {
      seen.edges.set(key, { delay: Math.max(seen.nodes.get(edge.source) ?? 0, seen.nodes.get(edge.target) ?? 0) + 120, claimed: false })
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
      data: { ...edge.data, arrival: seen.edges.get(connectionKey(edge)) },
    })),
  }
}
