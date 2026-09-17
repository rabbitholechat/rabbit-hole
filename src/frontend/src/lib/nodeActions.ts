import type { NodeContext, ResponseNode, Session } from '../types'

export function nodeLabel(session: Session | null, id: string): string {
  const node = session?.nodes.find((n) => n.id === id)
  if (node?.type === 'response') return node.data.prompt
  if (node?.type === 'page') return node.data.source.title
  const entity = session?.contentGraph?.entities[id]
  return entity?.type === 'information' ? entity.title.quote : entity?.source.title ?? ''
}
export function nodeText(session: Session | null, id: string): string {
  const node = session?.nodes.find((n) => n.id === id)
  if (node?.type === 'response') return node.data.text
  if (node?.type === 'page') return `${node.data.source.title}\n${node.data.source.url}\n\n${node.data.source.summary}`
  const entity = session?.contentGraph?.entities[id]
  if (entity?.type === 'information') return entity.excerpt.quote
  return entity ? `${entity.source.title}\n${entity.source.url}${entity.source.content?.status === 'read' ? `\n\n${entity.source.content.summary || entity.source.content.text}` : ''}` : ''
}
export function nodeContext(session: Session | null, id: string | null): NodeContext | undefined {
  if (!id || session?.protocol !== 2 || session.mode !== 'live') return
  const entity = session.contentGraph?.entities[id]
  if (!entity) return
  return { node_id: id, kind: entity.type, title: nodeLabel(session, id), text: Array.from(nodeText(session, id)).slice(0, 12000).join('') }
}

// Earlier records kept the visual parent on the last response. Explicit selection records recover it.
export function responseParentId(session: Session, response: ResponseNode): string | null {
  const selected = session.contentGraph?.relations.filter((edge) =>
    edge.kind === 'uses_context' && edge.source === response.id &&
    session.nodes.some((n) => n.id === edge.target && (n.type === 'information' || n.type === 'source')),
  ) ?? []
  if (selected.length === 1) return selected[0].target
  if (response.data.parentId !== undefined) return response.data.parentId
  const responses = session.nodes.filter((n) => n.type === 'response')
  return responses[responses.findIndex((n) => n.id === response.id) - 1]?.id ?? null
}
