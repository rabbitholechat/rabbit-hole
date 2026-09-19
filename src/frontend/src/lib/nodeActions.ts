import { cardText } from './information'
import { ENTITY_KIND_LABELS, type InformationEntity, type NodeContext, type ResponseNode, type Session } from '../types'

export function entityInformation(session: Session | null, id: string): InformationEntity[] {
  const graph = session?.contentGraph
  if (!graph || graph.entities[id]?.type !== 'entity') return []
  const ids = [...new Set(graph.relations.flatMap((edge) =>
    edge.kind === 'has_information' && edge.source === id ? [edge.target]
      : edge.kind === 'about' && edge.target === id ? [edge.source] : []))]
  return ids.flatMap((key) => {
    const entity = graph.entities[key]
    return entity?.type === 'information' ? [entity] : []
  })
}

function entityTextParts(session: Session | null, id: string): string[] {
  const entity = session?.contentGraph?.entities[id]
  if (entity?.type !== 'entity') return []
  const information = entityInformation(session, id)
  return [[`${entity.name} (${ENTITY_KIND_LABELS[entity.subtype] ?? '기타'})`, entity.qualifier,
    entity.aliases.length ? `다른 이름: ${entity.aliases.join(', ')}` : '', `관련 정보 ${information.length}개`].filter(Boolean).join('\n'),
  ...information.map((item) => item.presentation ? cardText(item.presentation) : `${item.title.quote}\n${item.excerpt.quote}`)]
}

function entityContextText(session: Session | null, id: string): string {
  const parts = entityTextParts(session, id)
  const text = parts.join('\n\n')
  if (Array.from(text).length <= 12000) return text
  // Share the bounded context across cards so one long card cannot silently hide all later ones.
  const limit = 12000
  const notice = '\n\n[길이 제한으로 일부 내용 생략. 조건·예외를 포함한 전체 정보는 원문 확인 필요.]'
  const header = Array.from(parts[0]).slice(0, 1000).join('')
  const cards = parts.slice(1, 41)
  const omitted = parts.length > 41 ? `\n[추가 정보 ${parts.length - 41}개 생략]` : ''
  const budget = Math.floor((limit - Array.from(header + notice + omitted).length) / Math.max(cards.length, 1)) - 2
  return [header, ...cards.map((card) => {
    const chars = Array.from(card)
    return chars.length <= budget ? card : chars.slice(0, budget - 5).join('') + ' [생략]'
  })].join('\n\n') + omitted + notice
}

export function nodeLabel(session: Session | null, id: string): string {
  const node = session?.nodes.find((n) => n.id === id)
  if (node?.type === 'response') return node.data.prompt
  if (node?.type === 'page') return node.data.source.title
  const entity = session?.contentGraph?.entities[id]
  if (entity?.type === 'entity') return entity.name
  return entity?.type === 'information' ? (entity.presentation?.heading ?? entity.title.quote) : entity?.source.title ?? ''
}
export function nodeText(session: Session | null, id: string): string {
  const node = session?.nodes.find((n) => n.id === id)
  if (node?.type === 'response') return node.data.text
  if (node?.type === 'page') return `${node.data.source.title}\n${node.data.source.url}\n\n${node.data.source.summary}`
  const entity = session?.contentGraph?.entities[id]
  if (entity?.type === 'entity') return entityTextParts(session, id).join('\n\n')
  if (entity?.type === 'information') return entity.presentation ? cardText(entity.presentation) : entity.excerpt.quote
  return entity ? `${entity.source.title}\n${entity.source.url}${entity.source.content?.status === 'read' ? `\n\n${entity.source.content.summary || entity.source.content.text}` : ''}` : ''
}
export function nodeContext(session: Session | null, id: string | null): NodeContext | undefined {
  if (!id || session?.protocol !== 2 || session.mode !== 'live') return
  const entity = session.contentGraph?.entities[id]
  if (!entity) return
  if (entity.type === 'entity') return { node_id: id, kind: 'entity', title: entity.name, text: entityContextText(session, id) }
  return { node_id: id, kind: entity.type, title: nodeLabel(session, id), text: Array.from(nodeText(session, id)).slice(0, 12000).join('') }
}

// Earlier records kept the visual parent on the last response. Explicit selection records recover it.
export function responseParentId(session: Session, response: ResponseNode): string | null {
  const selected = session.contentGraph?.relations.filter((edge) =>
    edge.kind === 'uses_context' && edge.source === response.id &&
    session.nodes.some((n) => n.id === edge.target && (n.type === 'information' || n.type === 'source' || n.type === 'entity')),
  ) ?? []
  if (selected.length === 1) return selected[0].target
  if (response.data.parentId !== undefined) return response.data.parentId
  const responses = session.nodes.filter((n) => n.type === 'response')
  return responses[responses.findIndex((n) => n.id === response.id) - 1]?.id ?? null
}
