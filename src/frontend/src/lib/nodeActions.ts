import type { NodeContext, Session } from '../types'

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
  return entity ? `${entity.source.title}\n${entity.source.url}` : ''
}
export function nodeContext(session: Session | null, id: string | null): NodeContext | undefined {
  if (!id || session?.protocol !== 2 || session.mode !== 'live') return
  const entity = session.contentGraph?.entities[id]
  if (!entity) return
  return { node_id: id, kind: entity.type, title: nodeLabel(session, id), text: nodeText(session, id) }
}
