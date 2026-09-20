import { EditNodeActions } from './CanvasEditor'
import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Maximize2, Minimize2, MessageCirclePlus } from 'lucide-react'
import { useStore } from '../store'
import { nodeContext, nodeText } from '../lib/nodeActions'

export function NodeActions({ id, collapsed, canCollapse }: { id: string; collapsed?: boolean; canCollapse: boolean }) {
  const session = useStore((s) => s.session)
  const busy = useStore((s) => Boolean(s.activeRequest))
  const replyTo = useStore((s) => s.replyTo)
  const reply = useStore((s) => s.reply)
  const toggle = useStore((s) => s.toggleNode)
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  async function copy() {
    useStore.getState().copyNode(id)
    clearTimeout(timer.current)
    try { await navigator.clipboard.writeText(nodeText(session, id)); setCopied(true); setFailed(false) }
    catch { setFailed(true) }
    timer.current = setTimeout(() => { setCopied(false); setFailed(false) }, 2000)
  }
  const copyLabel = failed ? '복사 실패 · 다시 시도' : copied ? '복사 완료' : '복사하기'
  return <div className="response-actions nodrag nopan" onClick={(e) => e.stopPropagation()}>
    <button aria-label={copyLabel} data-tooltip={copyLabel} onClick={() => void copy()}>
      {copied ? <Check size={17} /> : <Copy size={17} />}
    </button>
    <EditNodeActions id={id} />
    <button aria-label={collapsed ? '노드 펼치기' : '노드 접기'} disabled={!canCollapse} data-tooltip={!canCollapse ? '내용이 짧아 크기를 조절할 필요가 없습니다' : collapsed ? '노드 펼치기' : '노드 접기'}
      aria-expanded={!collapsed} onClick={() => toggle(id)}>
      {collapsed ? <Maximize2 size={17} /> : <Minimize2 size={17} />}
    </button>
    {!session?.readOnly && <button aria-label="다음 응답에 사용" data-tooltip="다음 응답에 사용" aria-pressed={replyTo === id}
      disabled={busy || !nodeContext(session, id)} onClick={() => reply(id)}>
      <MessageCirclePlus size={18} />
    </button>}
  </div>
}
