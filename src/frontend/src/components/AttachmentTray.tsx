import { FileText, LoaderCircle, X } from 'lucide-react'
import type { DraftAttachment } from '../types'
import { attachmentPath } from '../lib/attachments'

export function AttachmentTray({items, remove, disabled}: {
  items: DraftAttachment[]; remove: (id: string) => void; disabled: boolean
}) {
  if (!items.length) return null
  return <div className="composer-attachments" role="list" aria-label="첨부 자료">
    {items.map(item => <div className={`attachment-draft ${item.status}`} role="listitem" key={item.localId}>
      {item.status === 'uploading' ? <LoaderCircle className="attachment-spinner" size={19} /> :
        item.attachment?.kind === 'image' ? <img src={attachmentPath(item.attachment.id, '/preview')} alt="" /> : <FileText size={20} />}
      <div><strong>{item.name}</strong><small role="status">{item.status === 'uploading' ? '업로드 중' : item.status === 'failed' ? item.error : '첨부 완료'}</small></div>
      <button type="button" disabled={disabled} aria-label={`${item.name} 첨부 제거`} onClick={() => remove(item.localId)}><X size={14} /></button>
    </div>)}
  </div>
}
