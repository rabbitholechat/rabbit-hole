import { responseParentId } from '../lib/nodeActions'
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ChevronDown } from 'lucide-react'
import type { CanvasNode, Session } from '../types'
import { useStore } from '../store'

export function previousNodes(session: Session | null, id: string): CanvasNode[] {
  if (!session) return []
  const node = session.nodes.find((n) => n.id === id)
  let ids: string[] = []
  if (node?.type === 'response') {
    const parent = responseParentId(session, node)
    if (parent) ids = [parent]
  } else {
    const edges = session.protocol === 2 ? session.contentGraph?.relations ?? [] : session.graph.relations
    ids = edges.filter((e) => e.target === id && (!('kind' in e) || e.kind !== 'uses_context')).map((e) => e.source)
    const entityParents = edges.filter((e) => 'kind' in e && e.kind === 'has_information' && e.target === id).map((e) => e.source)
    if (entityParents.length) ids = entityParents
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
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        rootRef.current?.querySelector('button')?.focus()
      }
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  const parents = previousNodes(session, id)
  function go(id: string) { setOpen(false); navigate(id) }
  function label(node: CanvasNode) {
    if (node.type === 'response') return `응답 · ${node.data.prompt}`
    if (node.type === 'page') return node.data.source.title
    const entity = session?.contentGraph?.entities[node.id]
    return entity?.type === 'entity' ? `엔티티 · ${entity.name}` : entity?.type === 'information' ? `정보 · ${entity.presentation?.heading ?? entity.title.quote}` : '출처'
  }
  return (
    <div ref={rootRef} className="previous-node nodrag nopan" onClick={(event) => event.stopPropagation()}>
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
