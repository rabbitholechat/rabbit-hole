import { EditNodeActions, EditableNodeContent } from './CanvasEditor'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Check, Copy, Download, FileText, Maximize2, MessageCirclePlus, Minimize2, Paperclip } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AttachmentNode } from '../types'
import { attachmentPath, copyAttachment } from '../lib/attachments'
import { useStore } from '../store'

export function AttachmentCard({id, data, selected}: NodeProps<AttachmentNode>) {
  const readOnly = useStore(s => s.session?.readOnly)
  const attachment = data.attachment
  const collapsed = data.collapsed ?? true
  const [failed, setFailed] = useState(false)
  const [copyState, setCopyState] = useState('복사하기')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const busy = useStore(s => Boolean(s.activeRequest))
  const inComposer = useStore(s => s.draftAttachments.some(draft => draft.attachment?.id === attachment.id))
  const reuse = useStore(s => s.reuseAttachment)
  const toggle = useStore(s => s.toggleNode)
  async function copy() {
    useStore.getState().copyNode(id)
    clearTimeout(timer.current)
    try { await copyAttachment(attachment); setCopyState('복사 완료') }
    catch { setCopyState('복사 실패 · 다시 시도') }
    timer.current = setTimeout(() => setCopyState('복사하기'), 2000)
  }
  const type = attachment.kind === 'image' ? attachment.media_type.split('/')[1].toUpperCase()
    : attachment.media_type === 'application/pdf' ? 'PDF' : attachment.name.split('.').at(-1)?.toUpperCase()
  return <>
    <Handle type="target" position={Position.Left} />
    <article className={`content-card attachment-card ${collapsed ? 'is-compact' : 'is-expanded'} ${selected ? 'is-selected' : ''} ${inComposer ? 'is-reply-target' : ''}`} aria-label={`첨부 소스 · ${attachment.name}`}>
      <header><span className="node-tag"><Paperclip size={16} />소스</span>
        <div className="response-actions nodrag nopan" onClick={event => event.stopPropagation()}>
          <EditNodeActions id={id} />
          <button type="button" aria-label={copyState} data-tooltip={copyState === '복사하기' && attachment.media_type === 'application/pdf' ? '파일 링크 복사' : copyState} onClick={() => void copy()}>
            {copyState === '복사 완료' ? <Check size={17} /> : <Copy size={17} />}
          </button>
          <a className="attachment-download" href={attachmentPath(attachment.id, '/content')} download
            aria-label={`${attachment.name} 다운로드`} data-tooltip="다운로드"><Download size={17} /></a>
          <button type="button" aria-label={collapsed ? '노드 펼치기' : '노드 접기'} data-tooltip={collapsed ? '노드 펼치기' : '노드 접기'}
            aria-expanded={!collapsed} onClick={() => toggle(id)}>{collapsed ? <Maximize2 size={17} /> : <Minimize2 size={17} />}</button>
          {!readOnly && <button type="button" aria-label="다음 응답에 사용" data-tooltip="다음 응답에 사용" disabled={busy || inComposer} aria-pressed={inComposer}
            onClick={() => reuse(attachment)}><MessageCirclePlus size={18} /></button>}
        </div>
      </header>
      <EditableNodeContent id={id}>
      {attachment.kind === 'image' && !failed ?
        <img className="attachment-preview nodrag" src={attachmentPath(attachment.id, collapsed ? '/preview' : '/content')}
          alt={attachment.name} onError={() => setFailed(true)} /> :
        <div className="attachment-file-preview nodrag nopan">
          <FileText size={32} />
          <span>{failed ? '미리보기를 불러오지 못했습니다.' : type}</span>
        </div>}
      <h2 title={attachment.name}>{attachment.name}</h2>
      <footer><span>입력 자료</span><span>{type}{attachment.pages ? ` · ${attachment.pages}페이지` : ''} · {(attachment.size / 1000).toFixed(1)} KB</span></footer>
      </EditableNodeContent>
    </article>
    <Handle type="source" id="attachment-output" position={Position.Bottom} />
  </>
}
