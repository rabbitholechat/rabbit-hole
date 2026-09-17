import { RabbitLoader } from './RabbitLoader'
import { useCollapsibleContent } from '../hooks/useCollapsibleContent'
import { PreviousNodeButton } from './PreviousNodeButton'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Minimize2, Maximize2, MessageCirclePlus } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ResponseNode } from '../types'
import { NodeTag } from './NodeTag'
import { useStore } from '../store'
import { safeUrl } from '../lib/utils'

export function ResponseCard({ id, data, selected }: NodeProps<ResponseNode>) {
  const toggle = useStore((s) => s.toggleResponse)
  const reply = useStore((s) => s.reply)
  const busy = useStore((s) => Boolean(s.activeRequest))
  const structure = useStore((s) => s.structure)
  const cancelStructure = useStore((s) => s.cancelStructure)
  const graphJob = useStore((s) => s.session?.contentGraph?.jobs[id])
  const isReplyTarget = useStore((s) => s.replyTo === id)
  const { contentRef, canCollapse: canResize } = useCollapsibleContent(data.text, data.collapsed)
  const [copyState, setCopyState] = useState('복사하기')
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copyTimer.current), [])
  async function copy() {
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
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <article
        className={`response-card ${selected ? 'is-selected' : ''} ${isReplyTarget ? 'is-reply-target' : ''} ${data.collapsed ? 'is-collapsed' : ''}`}
        aria-label="에이전트 응답"
        aria-busy={data.status === 'streaming'}
      >
        <header>
          <NodeTag kind="response" />
          <small className="response-status" data-status={data.status}>
            {data.status === 'streaming' && <RabbitLoader />}
            {
              {
                streaming: '응답 중',
                completed: '완료',
                partial: '일부 응답',
                failed: '응답 실패',
                cancelled: '중지됨',
              }[data.status]
            }
          </small>
          <div className="response-actions nodrag nopan">
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
            <button
              type="button"
              aria-label="이어서 질문하기"
              aria-pressed={isReplyTarget}
              data-tooltip={
                isReplyTarget
                  ? '이어서 질문 해제'
                  : data.continuation
                    ? '이어서 질문하기'
                    : '완료된 대화 문맥이 필요합니다'
              }
              disabled={busy || data.status !== 'completed' || !data.continuation}
              onClick={() => reply(id)}
            >
              <MessageCirclePlus size={18} />
            </button>
          </div>
        </header>
        <h2 title={data.prompt}>{data.prompt}</h2>
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
        {data.status === 'completed' && graphJob?.status !== 'completed' && (
          <footer className="structure-status nodrag nopan" aria-live="polite">
            <span className="structure-indicator">
              {graphJob?.status === 'running' && <RabbitLoader />}
              {graphJob?.status === 'running'
                ? '정보 정리 중'
                : graphJob?.status === 'failed'
                  ? '정보 구조화 실패'
                  : graphJob?.status === 'cancelled'
                    ? '정보 정리 중지됨'
                    : '정보 노드 만들기'}
            </span>
            {graphJob?.status === 'running' ? (
              <button onClick={() => cancelStructure(id)}>구조화 중지</button>
            ) : (
                <button disabled={!data.continuation} onClick={() => void structure(id)}>
                  {graphJob ? '구조화 재시도' : '구조화'}
                </button>
            )}
          </footer>
        )}
        <PreviousNodeButton id={id} />
      </article>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  )
}
