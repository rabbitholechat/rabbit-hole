import { useEffect, useState } from 'react'
import { RabbitLoader } from './RabbitLoader'
import { useCollapsibleContent } from '../hooks/useCollapsibleContent'
import { NodeActions } from './NodeActions'
import { PreviousNodeButton } from './PreviousNodeButton'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ExternalLink } from 'lucide-react'
import type { InformationNode, SourceNode } from '../types'
import { useStore } from '../store'
import { safeUrl } from '../lib/utils'
import { InformationContent } from './InformationContent'
import { cardText } from '../lib/information'
import { NodeTag } from './NodeTag'

const sourceErrors: Record<string, string> = {
  budget_exhausted: '요청 한도로 본문을 가져오지 못했습니다.',
  page_timeout: '본문 조회 시간이 초과되었습니다.',
  page_blocked: '사이트에서 자동 접근을 제한하고 있습니다.',
  page_not_found: '페이지를 찾을 수 없습니다.',
  page_size_limit: '용량 제한 안에서 기사 본문을 확보하지 못했습니다.',
  unsupported_content_type: '지원하지 않는 문서 형식입니다.',
  unsupported_encoding: '지원하지 않는 압축 형식입니다.',
  empty_page: '읽을 수 있는 본문이 없습니다.',
  unsafe_url: '안전하게 접근할 수 없는 링크입니다.',
}
const kinds = { concept: '개념', entity: '대상', claim: '주장', example: '예시', comparison: '비교', procedure: '진행 방법' }
export function ContentCard({ id, data, selected }: NodeProps<InformationNode | SourceNode>) {
  const informationPending = 'pendingForResponseId' in data && Boolean(data.pendingForResponseId)
  const isReplyTarget = useStore((s) => s.replyTo === id)
  const [arrivalFinished, setArrivalFinished] = useState(false)
  useEffect(() => {
    if (isReplyTarget) setArrivalFinished(true)
  }, [isReplyTarget])
  const entity = useStore((s) => s.session?.contentGraph?.entities[data.entityId])
  const { contentRef, canCollapse } = useCollapsibleContent(entity?.type === 'information' ? entity.presentation ? cardText(entity.presentation) : entity.excerpt.quote : `${entity?.source.content?.status ?? ''}:${entity?.source.content?.summary || entity?.source.content?.text || ''}`, data.collapsed)
  const collapsed = Boolean(data.collapsed && canCollapse)
  const [imageFailed, setImageFailed] = useState(false)
  if (informationPending) return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <article className="content-card information-card information-pending" aria-label="정보 노드" aria-busy="true">
        <header>
          <NodeTag kind="information" />
          <small className="response-status" data-status="structuring" role="status">
            <RabbitLoader /> 생성 중
          </small>
        </header>
        <h2>응답을 정보로 정리하고 있어요</h2>
        <div className="information-body response-content" aria-hidden="true">
          <span className="information-pending-line" />
          <span className="information-pending-line short" />
          <span className="information-pending-line" />
        </div>
      </article>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  )
  if (!entity) return null
  const source = entity.type === 'source' ? entity.source : null
  const content = source?.content
  const pending = content?.status === 'reading' || content?.status === 'summarizing'
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <article
        className={`content-card ${source?.image ? 'image-card' : ''} ${arrivalFinished ? 'arrival-finished' : ''} ${entity.type}-card ${selected ? 'is-selected' : ''} ${isReplyTarget ? 'is-reply-target' : ''} ${collapsed ? 'is-collapsed' : ''}`}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget && ['content-arrive', 'page-arrive'].includes(event.animationName)) setArrivalFinished(true)
        }}
        aria-label={source ? '출처 노드' : '정보 노드'}
        aria-busy={pending}
      >
        <header>
          <NodeTag kind={source?.image ? 'image' : entity.type} />
          {entity.type === 'information' && <small className="response-status">{entity.presentation ? '답변에서 재정리' : kinds[entity.subtype]}</small>}
          {source && !source.image && <small className="response-status source-progress" role="status">
            {pending && <RabbitLoader />}
            {content?.status === 'reading' ? '조회 중' : content?.status === 'summarizing' ? '요약 중' : content?.status === 'cancelled' ? '요약 중지됨' : content?.summary ? content.summary_error ? '일부 요약' : '요약 완료' : ''}
          </small>}
          <NodeActions id={id} collapsed={collapsed} canCollapse={canCollapse} />
        </header>
        {entity.type === 'information' ? (
          <>
            <h2 title={entity.presentation?.heading ?? entity.title.quote}>{entity.presentation?.heading ?? entity.title.quote}</h2>
            <div ref={contentRef} className={`information-body response-content nodrag nopan ${collapsed ? 'nowheel' : ''}`} tabIndex={collapsed ? 0 : undefined}>
              {entity.presentation ? <InformationContent card={entity.presentation} /> : <ReactMarkdown
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
                {entity.excerpt.quote}
              </ReactMarkdown>}
            </div>
          </>
        ) : entity.source.image ? (
          <>
            {imageFailed ? <p className="image-preview-placeholder">이미지를 불러오지 못했습니다.</p> : (
              <a className="image-preview-link nodrag nopan" href={safeUrl(entity.source.url)} target="_blank" rel="noopener noreferrer">
                <img className="image-preview" src={entity.source.image.thumbnail_url} alt={entity.source.title}
                  loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setImageFailed(true)} />
              </a>
            )}
            <h2 title={entity.source.title}>{entity.source.title}</h2>
          </>
        ) : (
          <>
            <h2 title={entity.source.title}>{entity.source.title}</h2>
            <p className="source-domain">{new URL(entity.source.url).hostname}</p>
            <p className="source-access">페이지 요약</p>
            {pending && !content?.summary ? (
              <p className="source-content-note source-pending">
                {content?.status === 'reading' ? '페이지 내용을 가져오고 있어요.' : '읽은 내용을 요약하고 있어요.'}
              </p>
            ) : content && (content.status === 'read' || Boolean(content.summary)) ? (
              <>
                {content.summary && (content.summary_error || content.status === 'cancelled') && <p className="source-content-note">요약이 중단되어 생성된 부분만 표시합니다.</p>}
                {!content.summary && <p className="source-content-note">
                  {content.summary_error ? '요약을 완료하지 못했습니다. 확보한 원문을 표시합니다.' : '이전 기록에 요약이 없어 확보한 원문을 표시합니다.'}
                </p>}
                <div ref={contentRef} className={`source-body nodrag nopan ${collapsed ? 'nowheel' : ''}`} tabIndex={collapsed ? 0 : undefined}>
                  {content.summary || content.text}
                </div>
                {content.truncated && <small className="source-content-note">{content.summary ? '본문 일부 기준 요약' : '본문 일부 · 길이 제한으로 잘림'}</small>}
              </>
            ) : (
              <p className="source-content-note">
                {content?.status === 'cancelled'
                  ? '페이지 처리가 중지되었습니다.'
                  : sourceErrors[content?.error_code ?? '']
                    ?? (content?.status === 'failed' ? '이 페이지의 본문을 가져오지 못했습니다.' : '저장된 페이지 요약이 없습니다.')}
              </p>
            )}
          </>
        )}
        <footer className="node-footer">
          {source && (
            <a
              className="source-link node-button nodrag nopan"
              href={safeUrl(source.url)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {source.image ? '원본 페이지' : '페이지 열기'} <ExternalLink size={13} />
            </a>
          )}
          <PreviousNodeButton id={id} />
        </footer>
      </article>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  )
}
