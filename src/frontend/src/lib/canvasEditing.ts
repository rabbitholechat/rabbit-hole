import { ENTITY_KIND_LABELS } from '../types'
import type { CanvasNode, CanvasEdits, Session, UserNodeData } from '../types'
import { nodeLabel, nodeText, responseParentId } from './nodeActions'
import { safeUrl } from './utils'

export const emptyEdits = (): CanvasEdits => ({
  nodes: [],
  hiddenNodes: [],
  edges: [],
  hiddenEdges: [],
  positions: {},
})
export const editLocked = (session: Session | null) =>
  !session || session.readOnly ||
  session.status === 'running' ||
  Object.values(session.contentGraph?.jobs ?? {}).some((j) => j.status === 'running')
export function visibleNodes(session: Session | null): CanvasNode[] {
  if (!session) return []
  const edits = session.canvasEdits ?? emptyEdits()
  const replacements = new Map(edits.nodes.map((n) => [n.id, n]))
  const originals = new Set(session.nodes.map((n) => n.id))
  return [
    ...session.nodes.map((n) => replacements.get(n.id) ?? n),
    ...edits.nodes.filter((n) => !originals.has(n.id)),
  ]
    .filter((n) => !edits.hiddenNodes.includes(n.id))
    .map((n) => ({ ...n, position: edits.positions[n.id] ?? n.position }))
}
export function defaultConnectionLabel(session: Session | null, source: string, target: string): string {
  const nodes = visibleNodes(session)
  const kind = (id: string) => {
    const node = nodes.find((n) => n.id === id)
    if (node?.type === 'user') return node.data.kind
    if (node?.type === 'source') {
      const entity = session?.contentGraph?.entities[node.data.entityId]
      return entity?.type === 'source' && entity.source.image ? 'image' : 'source'
    }
    return node?.type
  }
  const from = kind(source),
    to = kind(target)
  if (from === 'entity' && to === 'information') return '관련 정보'
  if (from === 'information' && to === 'entity') return '설명 대상'
  if (to === 'entity') return '대상'
  if (to === 'image') return '관련 이미지'
  if (to === 'source' || to === 'page') return '출처'
  if (from === 'attachment') return '입력 자료'
  if (to === 'information') return from === 'response' ? '정보 추출' : '관련 정보'
  if (from === 'response' && to === 'response') return '대화 순서'
  if (to === 'response') return '맥락 참고'
  return '연결'
}
export type CanvasLink = {
  id: string
  source: string
  target: string
  label: string
  kind: string
  sourceHandle?: string | null
  targetHandle?: string | null
}
export function visibleLinks(session: Session | null): CanvasLink[] {
  if (!session) return []
  const links: CanvasLink[] = []
  if (session.protocol === 2) {
    for (const n of session.nodes)
      if (n.type === 'response') {
        const parent = responseParentId(session, n)
        if (parent)
          links.push({
            id: `conversation-${parent}-${n.id}`,
            source: parent,
            target: n.id,
            label: '대화 순서',
            kind: 'conversation',
          })
        for (const a of n.data.attachments ?? [])
          links.push({
            id: `input-attachment_${a.id}-${n.id}`,
            source: `attachment_${a.id}`,
            target: n.id,
            label: '입력 자료',
            kind: 'input',
          })
      }
    for (const e of session.contentGraph?.relations ?? []) {
      if (
        e.kind === 'has_extract' &&
        session.contentGraph?.relations.some((r) => r.kind === 'has_information' && r.target === e.target)
      )
        continue
      const response = session.nodes.find((n) => n.id === e.source)
      if (
        e.kind === 'uses_context' &&
        response?.type === 'response' &&
        responseParentId(session, response) === e.target
      )
        continue
      links.push({
        ...e,
        label: {
          has_entity: '대상',
          has_information: '관련 정보',
          about: '설명 대상',
          has_extract: '정보 추출',
          consulted: '조회',
          cites: '출처 표기',
          uses_context: '맥락 참고',
          related_image: '관련 이미지',
        }[e.kind],
      })
    }
  } else session.graph.relations.forEach((e, i) => links.push({ ...e, id: `edge-${i}` }))
  const edits = session.canvasEdits ?? emptyEdits()
  const replacements = new Set(edits.edges.map((e) => e.id))
  const nodes = new Set(visibleNodes(session).map((n) => n.id))
  const editedNodes = new Set(edits.nodes.map((n) => n.id))
  return [
    ...links.filter((e) => !replacements.has(e.id)),
    ...edits.edges.map((e) => ({ ...e, kind: 'manual' })),
  ]
    .filter((e) => !edits.hiddenEdges.includes(e.id) && nodes.has(e.source) && nodes.has(e.target))
    .map((e) =>
      e.kind !== 'manual' &&
      e.kind !== 'conversation' &&
      (editedNodes.has(e.source) || editedNodes.has(e.target))
        ? { ...e, kind: 'manual', label: defaultConnectionLabel(session, e.source, e.target) }
        : e,
    )
}
export function nodeDraft(session: Session, id: string): UserNodeData | undefined {
  const n = visibleNodes(session).find((n) => n.id === id)
  if (!n) return
  if (n.type === 'user') return structuredClone(n.data)
  const entity = session.contentGraph?.entities[id]
  const source = entity?.type === 'source' ? entity.source : undefined
  const kind =
    n.type === 'response'
      ? 'response'
      : n.type === 'entity'
        ? 'entity'
        : source?.image || (n.type === 'attachment' && n.data.attachment.kind === 'image')
          ? 'image'
          : n.type === 'source' || n.type === 'page'
            ? 'source'
            : 'information'
  return {
    kind,
    title: nodeLabel(session, id),
    text:
      n.type === 'entity'
        ? ''
        : n.type === 'response'
          ? n.data.text
          : entity?.type === 'source'
            ? source?.content?.summary || source?.content?.text || ''
            : n.type === 'page'
              ? n.data.source.summary
              : nodeText(session, id),
    url:
      source?.url ??
      (n.type === 'page' ? n.data.source.url : n.type === 'attachment' ? n.data.attachment.download_url : ''),
    imageUrl:
      source?.image?.thumbnail_url ?? (n.type === 'attachment' ? (n.data.attachment.preview_url ?? '') : ''),
    collapsed: n.data.collapsed,
    ...(n.type === 'attachment' ? { attachment: structuredClone(n.data.attachment) } : {}),
    ...(n.type === 'page' ? { page: structuredClone(n.data.source) } : {}),
    label:
      n.type === 'response'
        ? {
            streaming: '응답 중',
            completed: '완료',
            partial: '일부 응답',
            failed: '응답 실패',
            cancelled: '중지됨',
          }[n.data.status]
        : entity?.type === 'entity'
          ? ENTITY_KIND_LABELS[entity.subtype]
          : entity?.type === 'information'
            ? entity.presentation
              ? '정보 정리'
              : {
                  concept: '개념',
                  entity: '대상',
                  claim: '주장',
                  example: '예시',
                  comparison: '비교',
                  procedure: '진행 방법',
                }[entity.subtype]
            : source?.content?.summary
              ? '요약 완료'
              : '',
    ...(entity?.type === 'information' && entity.presentation
      ? { presentation: structuredClone(entity.presentation) }
      : {}),
    ...(entity?.type === 'entity'
      ? { entitySubtype: entity.subtype, qualifier: entity.qualifier, aliases: [...entity.aliases] }
      : {}),
  }
}
export function userImageUrl(raw: string): string | undefined {
  // Only the existing attachment preview route is accepted as a same-origin image.
  return /^\/api\/attachments\/[0-9a-f-]{36}\/preview$/i.test(raw) ? raw : safeUrl(raw)
}
export function userPageUrl(raw: string): string | undefined {
  return /^\/api\/attachments\/[0-9a-f-]{36}\/content$/i.test(raw) ? raw : safeUrl(raw)
}
export function validateDraft(data: UserNodeData): string | null {
  if (!data.title.trim()) return '이름 또는 제목을 입력해 주세요.'
  if (['source', 'image'].includes(data.kind) && !userPageUrl(data.url))
    return '접근 가능한 공개 http 또는 https 페이지 주소를 입력해 주세요.'
  if (data.kind === 'image' && !userImageUrl(data.imageUrl))
    return '접근 가능한 공개 http 또는 https 이미지 주소를 입력해 주세요.'
  return null
}
