import { useEffect, useRef, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Copy, Pencil, Trash2, X } from 'lucide-react'
import { useStore } from '../store'
import type { UserNode, UserNodeData } from '../types'
import { editLocked, nodeDraft, validateDraft, visibleLinks, visibleNodes, userImageUrl, userPageUrl } from '../lib/canvasEditing'
import { NodeTag } from './NodeTag'
import { PreviousNodeButton } from './PreviousNodeButton'
import { nodeLabel } from '../lib/nodeActions'

export function EditNodeActions({ id }: { id: string }) {
  const locked = useStore(s => editLocked(s.session) || !!s.loadingSessionId)
  return <>
    <button type="button" aria-label="노드 수정하기" data-tooltip="수정하기 · F2" disabled={locked} onClick={e => { e.stopPropagation(); useStore.getState().editNode(id) }}><Pencil size={16} /></button>
    <button type="button" aria-label="노드 삭제하기" data-tooltip="삭제하기 · Delete / ⌘⌫" disabled={locked} onClick={e => { e.stopPropagation(); useStore.getState().deleteNode(id) }}><Trash2 size={16} /></button>
  </>
}
export function UserCard({ id, data, selected }: NodeProps<UserNode>) {
  const session = useStore(s => s.session)
  const [imageFailed, setImageFailed] = useState(false)
  useEffect(() => setImageFailed(false), [data.imageUrl])
  const related = visibleLinks(session).filter(e => e.source === id && visibleNodes(session).some(n => n.id === e.target && (n.type === 'information' || n.type === 'user' && n.data.kind === 'information')))
  return <>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <article className={`content-card user-card ${data.kind}-card ${selected ? 'is-selected' : ''}`} aria-label="사용자 편집 노드">
      <header><NodeTag kind={data.kind} /><small className="response-status">사용자 편집</small>
        <div className="response-actions nodrag nopan"><button aria-label="복사하기" onClick={e => { e.stopPropagation(); useStore.getState().copyNode(id); void navigator.clipboard?.writeText(`${data.title}\n${data.text}`).catch(() => {}) }}><Copy size={17} /></button><EditNodeActions id={id} /></div>
      </header>
      {data.kind === 'response' && <small>사용자 질문</small>}<h2>{data.title}</h2>
      {data.kind === 'image' && (imageFailed ? <p>이미지를 불러오지 못했습니다.</p> : userImageUrl(data.imageUrl) && <img className="image-preview" src={userImageUrl(data.imageUrl)} alt={data.title} referrerPolicy="no-referrer" onError={() => setImageFailed(true)} />)}
      {data.kind !== 'entity' && <div className="user-node-text nodrag nopan nowheel">{data.text}</div>}
      <footer className="node-footer">
        {['source', 'image'].includes(data.kind) && userPageUrl(data.url) && <a className="node-button nodrag nopan" href={userPageUrl(data.url)} target="_blank" rel="noopener noreferrer">{data.kind === 'image' ? '원본 페이지' : '페이지 열기'}</a>}
        {data.kind === 'entity' && <button className="node-button nodrag nopan" disabled={!related.length} onClick={() => useStore.getState().navigateTo(related[0].target)}>관련 정보 {related.length}</button>}
        <PreviousNodeButton id={id} />
      </footer>
    </article>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </>
}
const kinds: Record<UserNodeData['kind'], string> = { response: '응답', entity: '엔티티', information: '정보', source: '출처', image: '이미지' }
export function CanvasEditor() {
  const state = useStore()
  const dialog = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState<UserNodeData | null>(null)
  const [edge, setEdge] = useState<{ id: string; source: string; target: string; label: string } | null>(null)
  const [error, setError] = useState('')
  const id = state.editingNode ?? state.editingEdge
  useEffect(() => {
    const s = useStore.getState()
    setError('')
    setDraft(s.session && s.editingNode ? nodeDraft(s.session, s.editingNode) ?? null : null)
    setEdge(s.editingEdge ? visibleLinks(s.session).find(e => e.id === s.editingEdge) ?? null : null)
    if (id) dialog.current?.showModal()
    else dialog.current?.close()
  }, [id, state.session?.id])
  function close() { state.editNode(null); state.editEdge(null) }
  function field(key: keyof UserNodeData, label: string, multiline = false) {
    if (!draft) return null
    return <label>{label}{multiline ? <textarea aria-label={label} rows={8} value={String(draft[key] ?? '')} onChange={e => { setError(''); setDraft({ ...draft, [key]: e.target.value }) }} /> : <input aria-label={label} value={String(draft[key] ?? '')} onChange={e => { setError(''); setDraft({ ...draft, [key]: e.target.value }) }} />}</label>
  }
  return <dialog ref={dialog} className="canvas-editor" aria-label={draft ? '노드 수정' : '간선 수정'} onCancel={close} onClick={e => { if (e.target === dialog.current) close() }}>
    <form onSubmit={e => {
      e.preventDefault()
      if (draft && state.editingNode) { const message = validateDraft(draft); if (message) { setError(message); return }; state.saveNode(state.editingNode, draft) }
      if (edge) { if (edge.source === edge.target) { setError('서로 다른 노드를 선택해 주세요.'); return }; state.saveEdge(edge) }
    }}>
      <header><h2>{draft ? '노드 수정' : '간선 수정'}</h2><button type="button" aria-label="편집 닫기" onClick={close}><X size={20} /></button></header>
      {draft && <>
        <label>노드 유형<select value={draft.kind} onChange={e => { setError(''); setDraft({ ...draft, kind: e.target.value as UserNodeData['kind'] }) }}>{Object.entries(kinds).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        {field('title', draft.kind === 'response' ? '사용자 질문' : draft.kind === 'entity' ? '엔티티 이름' : '제목')}
        {draft.kind === 'response' && field('text', '응답', true)}
        {draft.kind === 'information' && field('text', '정보 내용', true)}
        {draft.kind === 'source' && <>{field('url', '출처 URL')}{field('text', '출처 요약', true)}</>}
        {draft.kind === 'image' && <>{field('imageUrl', '이미지 URL')}{field('url', '원본 페이지 URL')}</>}
      </>}
      {edge && <>
        {(['source', 'target'] as const).map(key => <label key={key}>{key === 'source' ? '시작 노드' : '도착 노드'}<select value={edge[key]} onChange={e => setEdge({ ...edge, [key]: e.target.value })}>{visibleNodes(state.session).map(n => <option key={n.id} value={n.id}>{nodeLabel(state.session, n.id) || n.id}</option>)}</select></label>)}
        <label>연결 이름<input value={edge.label} onChange={e => setEdge({ ...edge, label: e.target.value })} /></label>
      </>}
      <p className="editor-note">변경 내용은 사용자 편집으로 저장됩니다. 원본 응답과 출처 기록은 보존됩니다.</p>
      {error && <p role="alert">{error}</p>}
      <footer><button type="button" onClick={close}>취소</button><button type="submit" disabled={editLocked(state.session)}>저장</button></footer>
    </form>
  </dialog>
}
