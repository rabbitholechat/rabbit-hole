import { Handle, Position, type NodeProps } from '@xyflow/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ExternalLink, FileText } from 'lucide-react'
import type { InformationNode, SourceNode } from '../types'
import { useStore } from '../store'
import { safeUrl } from '../lib/utils'
import { NodeTag } from './NodeTag'

const kinds = { concept: '개념', entity: '대상', claim: '주장', example: '예시', comparison: '비교' }
export function ContentCard({ data, selected }: NodeProps<InformationNode | SourceNode>) {
  const entity = useStore((s) => s.session?.contentGraph?.entities[data.entityId])
  const reveal = useStore((s) => s.revealOrigin)
  if (!entity) return null
  const source = entity.type === 'source' ? entity.source : null
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <article
        className={`content-card ${entity.type}-card ${selected ? 'is-selected' : ''}`}
        aria-label={source ? '출처 노드' : '정보 노드'}
      >
        <header>
          <NodeTag kind={entity.type} />
          {entity.type === 'information' && <small>{kinds[entity.subtype]}</small>}
        </header>
        {entity.type === 'information' ? (
          <>
            <h2 title={entity.title.quote}>{entity.title.quote}</h2>
            <div className="information-body response-content nodrag nopan nowheel">
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
            <button
              className="content-origin nodrag nopan"
              onClick={() => reveal(entity.responseId, entity.excerpt.quote)}
            >
              <FileText size={13} /> 원문 보기{' '}
              <small>
                {entity.excerpt.start + 1}–{entity.excerpt.end}자
              </small>
            </button>
          </>
        ) : (
          <>
            <h2 title={entity.source.title}>{entity.source.title}</h2>
            <p className="source-domain">{new URL(entity.source.url).hostname}</p>
            <p className="source-access">
              {entity.source.access === 'page_read' ? '본문 조회' : '검색 결과'} <span>· 미검증</span>
            </p>
            <a
              className="source-link nodrag nopan"
              href={safeUrl(entity.source.url)}
              target="_blank"
              rel="noopener noreferrer"
            >
              페이지 열기 <ExternalLink size={13} />
            </a>
          </>
        )}
      </article>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  )
}
