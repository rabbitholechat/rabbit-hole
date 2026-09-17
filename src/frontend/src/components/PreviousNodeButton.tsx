import { useState } from 'react'
import { ArrowLeft, ChevronDown } from 'lucide-react'
import type { CanvasNode, Session } from '../types'
import { useStore } from '../store'

export function previousNodes(session: Session | null, id: string): CanvasNode[] {
  if (!session) return []
  const node = session.nodes.find((n) => n.id === id)
  let ids: string[] = []
  if (node?.type === 'response') {
    const responses = session.nodes.filter((n) => n.type === 'response')
    const parent = node.data.parentId === undefined
      ? responses[responses.findIndex((n) => n.id === id) - 1]?.id
      : node.data.parentId
    if (parent) ids = [parent]
  } else {
    const edges = session.protocol === 2 ? session.contentGraph?.relations ?? [] : session.graph.relations
    ids = edges.filter((e) => e.target === id && (!('kind' in e) || e.kind !== 'uses_context')).map((e) => e.source)
  }
  return [...new Set(ids)].flatMap((parent) => {
    const node = session.nodes.find((n) => n.id === parent)
    return node && parent !== id ? [node] : []
  })
}

export function PreviousNodeButton({ id }: { id: string }) {
  const session = useStore((s) => s.session)
  const navigate = useStore((s) => s.navigateTo)
  const [open, setOpen] = useState(false)
  const parents = previousNodes(session, id)
  function go(id: string) { setOpen(false); navigate(id) }
  function label(node: CanvasNode) {
    if (node.type === 'response') return `응답 · ${node.data.prompt}`
    if (node.type === 'page') return node.data.source.title
    const entity = session?.contentGraph?.entities[node.id]
    return entity?.type === 'information' ? `정보 · ${entity.title.quote}` : '출처'
  }
  return (
    <div className="previous-node nodrag nopan" onClick={(event) => event.stopPropagation()}>
      <button className="node-button" disabled={!parents.length}
        title={!parents.length ? '이전 노드가 없습니다' : undefined}
        aria-expanded={parents.length > 1 ? open : undefined}
        onClick={() => parents.length === 1 ? go(parents[0].id) : setOpen(!open)}>
        <ArrowLeft size={14} /> 이전 노드로 {parents.length > 1 && <ChevronDown size={13} />}
      </button>
      {open && parents.length > 1 && (
        <div className="previous-node-options nowheel" aria-label="이전 노드 선택">
          {parents.map((node) => <button key={node.id} title={label(node)} onClick={() => go(node.id)}>{label(node)}</button>)}
        </div>
      )}
    </div>
  )
}
