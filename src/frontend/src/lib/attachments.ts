import { visibleNodes } from './canvasEditing'
import type { Attachment, AttachmentLimits, AttachmentNode, ResponseNode, Session } from '../types'

export const attachmentPath = (id: string, suffix = '') => `/api/attachments/${encodeURIComponent(id)}${suffix}`
export function parseAttachment(value: unknown): Attachment {
  if (!value || typeof value !== 'object') throw Error('첨부 정보를 읽을 수 없습니다.')
  const a = value as Attachment
  if (!/^[0-9a-f-]{36}$/i.test(a.id) || !['image', 'file'].includes(a.kind) || typeof a.name !== 'string'
    || typeof a.media_type !== 'string' || !Number.isSafeInteger(a.size) || a.size < 1
    || a.download_url !== attachmentPath(a.id, '/content')
    || (a.preview_url != null && a.preview_url !== attachmentPath(a.id, '/preview'))
    || typeof a.text_excerpt !== 'string' || a.text_excerpt.length > 1600) throw Error('첨부 정보를 읽을 수 없습니다.')
  return a
}
async function failure(response: Response): Promise<never> {
  const data = await response.json().catch(() => ({}))
  throw Error(typeof data.detail === 'string' ? data.detail : '첨부를 처리하지 못했습니다. 다시 시도해 주세요.')
}
export async function attachmentLimits(): Promise<AttachmentLimits> {
  const response = await fetch('/api/attachments/limits')
  if (!response.ok) return failure(response)
  const data = await response.json()
  if (!Number.isSafeInteger(data.max_bytes) || !Number.isSafeInteger(data.max_count) || data.max_count < 1 || data.max_count > 4)
    throw Error('첨부 설정을 읽을 수 없습니다.')
  return data
}
export async function uploadAttachment(file: File, signal: AbortSignal): Promise<Attachment> {
  const response = await fetch(`/api/attachments?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal,
  })
  if (!response.ok) return failure(response)
  return parseAttachment(await response.json())
}
export async function deleteDraftAttachment(id: string) {
  await fetch(attachmentPath(id), { method: 'DELETE' }).catch(() => {})
}

// Attachments occupy an explicit input band above their response from the first render.
// Never relocate existing nodes, including sources reused on retry.
export function appendResponse(session: Session, responseId: string, requestId: string, parentId: string | null,
  query: string, attachments: Attachment[]): Session {
  if (session.nodes.some(n => n.id === responseId)) return session
  const width = Math.min(560, window.innerWidth - 48)
  const parent = visibleNodes(session).find(n => n.id === parentId)
  const x = parent ? parent.position.x + (parent.width || 560) + 64 : 0
  const column = session.nodes.filter(n => n.position.x < x + width && n.position.x + (n.width || 560) > x)
  const top = column.length ? Math.max(...column.map(n => n.position.y + (n.measured?.height ?? n.height ?? 400))) + 64 : parent?.position.y ?? 0
  const fresh = attachments.filter(a => !session.nodes.some(n => n.id === `attachment_${a.id}`))
  const columns = width >= 480 ? 2 : 1
  const cardWidth = columns === 2 && fresh.length > 1 ? (width - 24) / 2 : Math.min(width, 320)
  const inputs: AttachmentNode[] = fresh.map((attachment, index) => ({
    id: `attachment_${attachment.id}`, type: 'attachment', width: cardWidth, height: 260,
    position: { x: x + (index % columns) * (cardWidth + 24), y: top + Math.floor(index / columns) * 284 },
    data: { attachment },
  }))
  const y = top + (fresh.length ? Math.ceil(fresh.length / columns) * 284 + 32 : 0)
  const node: ResponseNode = {id: responseId, type: 'response', width, position: {x, y}, data: {
    parentId, prompt: query, requestedTool: session.lastRequestedTool, attachments, text: '', status: 'streaming',
  }}
  const timing = session.responseTimings?.[requestId]
  return {...session, nodes: [...session.nodes, ...inputs, node], responseTimings: timing
    ? {...session.responseTimings, [requestId]: {...timing, responseId}} : session.responseTimings}
}

// Text copies the full file; images copy pixels; PDF copies a usable original download link.
export async function copyAttachment(attachment: Attachment): Promise<void> {
  const url = attachmentPath(attachment.id, '/content')
  if (attachment.media_type === 'application/pdf') {
    await navigator.clipboard.writeText(`${attachment.name}\n${new URL(url, window.location.origin).href}`)
    return
  }
  if (attachment.kind === 'image' && (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined'))
    throw Error('이미지 복사를 지원하지 않는 브라우저입니다.')
  const response = fetch(url).then(async response => {
    if (!response.ok) throw Error('첨부를 불러오지 못했습니다.')
    return response
  })
  if (attachment.kind !== 'image') {
    await navigator.clipboard.writeText(await (await response).text())
    return
  }
  const png = response.then(async response => {
    const blob = await response.blob()
    if (attachment.media_type === 'image/png') return blob
    const bitmap = await createImageBitmap(blob)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width; canvas.height = bitmap.height
      const context = canvas.getContext('2d')
      if (!context) throw Error('이미지를 복사할 수 없습니다.')
      context.drawImage(bitmap, 0, 0)
      return await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(Error('이미지 변환 실패')), 'image/png'))
    } finally { bitmap.close() }
  })
  await Promise.all([png, navigator.clipboard.write([new ClipboardItem({'image/png': png})])])
}
