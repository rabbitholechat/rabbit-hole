import type { CanvasNode, ContentGraph } from '../types'

// Match card accents; edges use their destination's visual type, not evidence strength.
export const NODE_ACCENTS = {
  response: '#458c80',
  information: '#967423',
  entity: '#bc604e',
  source: '#3f73ab',
  image: '#8860b2',
  page: '#0f766e',
} as const

export function nodeAccent(node: CanvasNode | undefined, graph?: ContentGraph) {
  if (node?.type === 'source') {
    const entity = graph?.entities[node.data.entityId]
    return entity?.type === 'source' && entity.source.image ? NODE_ACCENTS.image : NODE_ACCENTS.source
  }
  return NODE_ACCENTS[node?.type ?? 'response']
}
