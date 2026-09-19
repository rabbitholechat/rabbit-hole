import { Select } from './ui/select'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { EdgeLabelRenderer } from '@xyflow/react'
import { Check, Pencil, Trash2, X } from 'lucide-react'
import { useStore } from '../store'
import type { UserNodeData } from '../types'
import { editLocked, validateDraft, visibleLinks } from '../lib/canvasEditing'

export function EditNodeActions({ id }: { id: string }) {
  const locked = useStore(s => editLocked(s.session) || !!s.loadingSessionId)
  return <>
    <button type="button" aria-label="수정하기" data-tooltip="수정하기 · F2" disabled={locked} onClick={e => { e.stopPropagation(); useStore.getState().editNode(id) }}><Pencil size={16} /></button>
    <button type="button" aria-label="삭제하기" data-tooltip="삭제하기 · Delete / ⌘⌫" disabled={locked} onClick={e => { e.stopPropagation(); useStore.getState().deleteNode(id) }}><Trash2 size={16} /></button>
  </>
}
const kinds: Record<UserNodeData['kind'], string> = { response: '응답', entity: '엔티티', information: '정보', source: '출처', image: '이미지' }
export function EditableNodeContent({ id, children }: { id: string; children: ReactNode }) {
  const editing = useStore(s => s.editingNode === id)
  return editing ? <InlineNodeEditor id={id} /> : children
}
function InlineNodeEditor({ id }: { id: string }) {
  const draft = useStore(s => s.editingDraft)!
  const setDraft = (editingDraft: UserNodeData) => useStore.setState({ editingDraft })
  const [error, setError] = useState('')
  const form = useRef<HTMLFormElement>(null)
  const locked = useStore(s => editLocked(s.session))
  useEffect(() => { form.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true }) }, [])
  function field(key: 'title' | 'text' | 'url' | 'imageUrl' | 'label', label: string, multiline = false) {
    return <label>{label}{multiline ? <textarea className="nowheel" aria-label={label} rows={5} value={draft[key] ?? ''} onChange={e => { setError(''); setDraft({ ...draft, [key]: e.target.value }) }} /> : <input aria-label={label} value={draft[key] ?? ''} onChange={e => { setError(''); setDraft({ ...draft, [key]: e.target.value }) }} />}</label>
  }
  return <form ref={form} className="inline-editor nodrag nopan" aria-label="수정하기" onClick={e => e.stopPropagation()} onKeyDown={e => {
    e.stopPropagation()
    if (e.key === 'Escape') { e.preventDefault(); useStore.getState().editNode(null) }
    if (!e.nativeEvent.isComposing && (e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); form.current?.requestSubmit() }
  }} onSubmit={e => {
    e.preventDefault(); e.stopPropagation()
    const message = validateDraft(draft)
    if (message) { setError(message); return }
    useStore.getState().saveNode(id, draft)
  }}>
    <div className="inline-editor-fields">
    <Select label="노드 유형" value={draft.kind} options={Object.entries(kinds).map(([value, label]) => ({ value, label }))} onChange={value => {
      setError(''); setDraft({ ...draft, attachment: undefined, page: undefined, kind: value as UserNodeData['kind'], label: value === 'response' ? '완료' : value === 'entity' ? '기타' : '' })
    }} />
    {field('label', '상태 / 분류')}
    {field('title', draft.kind === 'response' ? '사용자 질문' : draft.kind === 'entity' ? '엔티티 이름' : '제목')}
    {draft.kind === 'response' && field('text', '응답', true)}
    {draft.kind === 'information' && field('text', '정보 내용', true)}
    {draft.kind === 'source' && <>{field('url', '출처 URL')}{field('text', '출처 요약', true)}</>}
    {draft.kind === 'image' && <>{field('imageUrl', '이미지 URL')}{field('url', '원본 페이지 URL')}</>}
    {error && <p role="alert">{error}</p>}
    </div>
    <footer><button type="button" onClick={() => useStore.getState().editNode(null)}>취소</button><button type="submit" disabled={locked}>저장</button></footer>
  </form>
}
export function InlineEdgeEditor({ id, x, y }: { id: string; x: number; y: number }) {
  const editing = useStore(s => s.editingEdge === id)
  return editing ? <EdgeLabelRenderer><EdgeEditorForm id={id} x={x} y={y} /></EdgeLabelRenderer> : null
}
function EdgeEditorForm({ id, x, y }: { id: string; x: number; y: number }) {
  const session = useStore(s => s.session)
  const [edge, setEdge] = useState(() => visibleLinks(session).find(e => e.id === id)!)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus({ preventScroll: true }); input.current?.select() }, [])
  function save() { useStore.getState().saveEdge(edge) }
  return <form className="edge-inline-editor nodrag nopan nowheel" aria-label="수정하기" style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y - 30}px)` }} onClick={e => e.stopPropagation()} onKeyDown={e => {
    e.stopPropagation()
    if (e.key === 'Escape') { e.preventDefault(); useStore.getState().editEdge(null) }
  }} onSubmit={e => { e.preventDefault(); e.stopPropagation(); save() }}>
    <input ref={input} aria-label="연결 이름" placeholder="연결 이름" value={edge.label} onChange={e => setEdge({ ...edge, label: e.target.value })} />
    <button type="submit" aria-label="저장" title="저장 · Enter" disabled={editLocked(session)}><Check size={15} /></button>
    <button type="button" aria-label="취소" title="취소 · Esc" onClick={() => useStore.getState().editEdge(null)}><X size={15} /></button>
  </form>
}
