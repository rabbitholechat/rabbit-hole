import { EditNodeActions, EditableNodeContent } from './CanvasEditor'
import { RabbitLoader } from './RabbitLoader'
import { useCollapsibleContent } from '../hooks/useCollapsibleContent'
import { PreviousNodeButton } from './PreviousNodeButton'
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Minimize2, Maximize2, MessageCirclePlus, Square, RotateCcw, ListTree } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ResponseNode } from '../types'
import { NodeTag } from './NodeTag'
import { useStore } from '../store'
import { safeUrl } from '../lib/utils'

export function ResponseCard({ id, data, selected, edited = false, displayLabel }: NodeProps<ResponseNode> & { edited?: boolean; displayLabel?: string }) {
  const readOnly = useStore(s => s.session?.readOnly)
  const editing = useStore(s => s.editingNode === id)
  const toggle = useStore((s) => s.toggleResponse)
  const reply = useStore((s) => s.reply)
  const busy = useStore((s) => Boolean(s.activeRequest))
  const structure = useStore((s) => s.structure)
  const cancelStructure = useStore((s) => s.cancelStructure)
  const graphJob = useStore((s) => s.session?.contentGraph?.jobs[id])
  const readingSources = useStore((s) => s.responseId === id && Boolean(s.activeRequest) && s.stage === '출처 본문을 읽고 있어요')
  const showStructureAction = !readOnly && !edited && data.status === 'completed' && !readingSources && graphJob?.status !== 'completed'
  const isStructuring = data.status === 'completed' && graphJob?.status === 'running'
  const requestRunning = useStore((s) => s.responseId === id && Boolean(s.activeRequest))
  const isGenerating = data.status === 'streaming' || isStructuring || requestRunning
  // CSS transforms do not trigger ResizeObserver; keep edge anchors on the animated handles.
  const updateNodeInternals = useUpdateNodeInternals()
  useEffect(() => {
    let frame = 0
    const sync = () => {
      updateNodeInternals(id)
      if (isGenerating) frame = requestAnimationFrame(sync)
    }
    sync()
    return () => cancelAnimationFrame(frame)
  }, [id, isGenerating, updateNodeInternals])
  const status = isStructuring || readingSources ? 'structuring' : data.status
  const statusText = edited ? displayLabel ?? '완료' : readingSources ? '출처 읽는 중' : isStructuring
    ? '정보 정리 중'
    : data.status === 'completed' && graphJob?.status === 'failed'
      ? '정보 정리 실패'
      : data.status === 'completed' && graphJob?.status === 'cancelled'
        ? '정보 정리 중지됨'
        : {
            streaming: '응답 중',
            completed: '완료',
            partial: '일부 응답',
            failed: '응답 실패',
            cancelled: '중지됨',
          }[data.status]
  const structureActionLabel = isStructuring ? '구조화 중지' : graphJob ? '구조화 재시도' : '구조화'
  const isReplyTarget = useStore((s) => s.replyTo === id)
  const { contentRef, canCollapse: canResize } = useCollapsibleContent(`${data.text}:${editing}`, data.collapsed)
  const [copyState, setCopyState] = useState('복사하기')
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copyTimer.current), [])
  async function copy() {
    useStore.getState().copyNode(id)
    clearTimeout(copyTimer.current)
    try {
      await navigator.clipboard.writeText(data.text)
      setCopyState('복사 완료')
    } catch {
      setCopyState('복사 실패 · 다시 시도')
    } finally {
      copyTimer.current = setTimeout(() => setCopyState('복사하기'), 2000)
    }
  }
  return (
    <>
      <article
        className={`response-card ${isGenerating ? 'is-generating' : ''} ${selected ? 'is-selected' : ''} ${isReplyTarget ? 'is-reply-target' : ''} ${data.collapsed ? 'is-collapsed' : ''}`}
        aria-label="에이전트 응답"
        aria-busy={isGenerating}
      >
        {!!data.attachments?.length && <Handle type="target" id="attachment-input" position={Position.Top} />}
        <Handle type="target" position={Position.Left} />
        <Handle type="source" position={Position.Right} />
        <header>
          <NodeTag kind="response" />
          <small className="response-status" data-status={status} role="status" title={edited ? '사용자가 복사하거나 수정한 내용' : undefined}>
            {(data.status === 'streaming' || isStructuring || readingSources) && <RabbitLoader />}
            {statusText}
          </small>
          <div className="response-actions nodrag nopan">
            <EditNodeActions id={id} />
            {showStructureAction && (
              <button
                type="button"
                aria-label={structureActionLabel}
                data-tooltip={structureActionLabel}
                disabled={!isStructuring && !data.continuation}
                onClick={() => isStructuring ? cancelStructure(id) : void structure(id)}
              >
                {isStructuring ? <Square size={15} /> : graphJob ? <RotateCcw size={17} /> : <ListTree size={17} />}
              </button>
            )}
            <button
              type="button"
              aria-label={copyState}
              data-tooltip={copyState}
              disabled={!data.text}
              onClick={() => void copy()}
            >
              {copyState === '복사 완료' ? <Check size={17} /> : <Copy size={17} />}
            </button>
            <button
              type="button"
              aria-label={data.collapsed ? '응답 확장' : '응답 접기'}
              data-tooltip={
                !canResize
                  ? '내용이 짧아 크기를 조절할 필요가 없습니다'
                  : data.collapsed
                    ? '응답 확장'
                    : '응답 접기'
              }
              disabled={!canResize}
              aria-expanded={!data.collapsed}
              onClick={() => toggle(id)}
            >
              {data.collapsed ? <Maximize2 size={17} /> : <Minimize2 size={17} />}
            </button>
            {!readOnly && <button
              type="button"
              aria-label={edited ? "다음 응답에 사용" : "이어서 질문하기"}
              aria-pressed={isReplyTarget}
              data-tooltip={
                isReplyTarget
                  ? '이어서 질문 해제'
                  : edited ? '다음 응답에 사용' : data.continuation
                    ? '이어서 질문하기'
                    : '완료된 대화 문맥이 필요합니다'
              }
              disabled={busy || (!edited && (data.status !== 'completed' || !data.continuation))}
              onClick={() => reply(id)}
            >
              <MessageCirclePlus size={18} />
            </button>}
          </div>
        </header>
        <EditableNodeContent id={id}>
        <section className="response-prompt nodrag nopan" aria-label="사용자 질문">
          <span className="response-prompt-label">질문</span>
          <h2>{data.prompt}</h2>
        </section>
        <div
          ref={contentRef}
          className={`response-content nodrag nopan ${data.collapsed && canResize ? 'nowheel' : ''}`}
          aria-label="응답 내용"
          tabIndex={data.collapsed ? 0 : undefined}
        >
          {data.text ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              skipHtml
              components={{
                a: ({ href, children }) => {
                  const url = href && safeUrl(href)
                  return url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  ) : (
                    <span>{children}</span>
                  )
                },
                img: ({ alt }) => <span>{alt}</span>,
              }}
            >
              {data.text}
            </ReactMarkdown>
          ) : (
            <p className="response-placeholder">
              {data.status === 'streaming' ? (
                <>
                  응답을 준비하고 있어요.
                </>
              ) : (
                '받은 응답이 없습니다.'
              )}
            </p>
          )}
        </div>
        <PreviousNodeButton id={id} />
        </EditableNodeContent>
      </article>
    </>
  )
}
