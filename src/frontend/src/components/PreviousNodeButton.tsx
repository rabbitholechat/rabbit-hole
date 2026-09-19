import { visibleLinks, visibleNodes } from '../lib/canvasEditing'
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ChevronDown } from 'lucide-react'
import type { CanvasNode, Session } from '../types'
import { useStore } from '../store'

export function previousNodes(session: Session | null, id: string): CanvasNode[] {
  if (!session) return []
  const ids = visibleLinks(session).filter(e => e.target === id).map(e => e.source)
  return visibleNodes(session).filter(n => ids.includes(n.id) && n.id !== id)
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
    if (node.type === 'user') return `사용자 편집 · ${node.data.title}`
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
