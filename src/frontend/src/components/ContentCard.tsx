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
import { NodeTag } from './NodeTag'

const kinds = { concept: '개념', entity: '대상', claim: '주장', example: '예시', comparison: '비교' }
export function ContentCard({ id, data, selected }: NodeProps<InformationNode | SourceNode>) {
  const entity = useStore((s) => s.session?.contentGraph?.entities[data.entityId])
  const { contentRef, canCollapse } = useCollapsibleContent(entity?.type === 'information' ? entity.excerpt.quote : entity?.source.content?.text ?? '', data.collapsed)
  const collapsed = Boolean(data.collapsed && canCollapse)
  if (!entity) return null
  const source = entity.type === 'source' ? entity.source : null
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <article
        className={`content-card ${entity.type}-card ${selected ? 'is-selected' : ''} ${collapsed ? 'is-collapsed' : ''}`}
        aria-label={source ? '출처 노드' : '정보 노드'}
      >
        <header>
          <NodeTag kind={entity.type} />
          {entity.type === 'information' && <small>{kinds[entity.subtype]}</small>}
          <NodeActions id={id} collapsed={collapsed} canCollapse={canCollapse} />
        </header>
        {entity.type === 'information' ? (
          <>
            <h2 title={entity.title.quote}>{entity.title.quote}</h2>
            <div ref={contentRef} className={`information-body response-content nodrag nopan ${collapsed ? 'nowheel' : ''}`} tabIndex={collapsed ? 0 : undefined}>
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
                {entity.excerpt.quote}
              </ReactMarkdown>
            </div>
          </>
        ) : (
          <>
            <h2 title={entity.source.title}>{entity.source.title}</h2>
            <p className="source-domain">{new URL(entity.source.url).hostname}</p>
            <p className="source-access">
              {entity.source.access === 'page_read' ? '본문 조회' : '검색 결과'}
            </p>
            {entity.source.content?.status === 'read' ? (
              <>
                <div ref={contentRef} className={`source-body nodrag nopan ${collapsed ? 'nowheel' : ''}`} tabIndex={collapsed ? 0 : undefined}>
                  {entity.source.content.text}
                </div>
                {entity.source.content.truncated && <small className="source-content-note">본문 일부 · 길이 제한으로 잘림</small>}
              </>
            ) : (
              <p className="source-content-note">
                {entity.source.content?.error_code === 'budget_exhausted'
                  ? '요청 한도로 본문을 가져오지 못했습니다.'
                  : entity.source.content?.error_code === 'page_timeout'
                    ? '본문 조회 시간이 초과되었습니다.'
                    : entity.source.content?.status === 'failed'
                      ? '이 페이지의 본문을 가져오지 못했습니다.'
                      : '저장된 본문이 없습니다.'}
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
              페이지 열기 <ExternalLink size={13} />
            </a>
          )}
          <PreviousNodeButton id={id} />
        </footer>
      </article>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  )
}
