import { useCollapsibleContent } from '../hooks/useCollapsibleContent'
import { NodeActions } from './NodeActions'
import { PreviousNodeButton } from './PreviousNodeButton'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { ExternalLink, Globe2 } from 'lucide-react'
import type { PageNode } from '../types'
import { cn, safeUrl } from '../lib/utils'
export function PageCard({ id, data, selected }: NodeProps<PageNode>) {
  const source = data.source,
    href = safeUrl(source.url)
  const { contentRef, canCollapse } = useCollapsibleContent(source.summary, data.collapsed)
  const collapsed = Boolean(data.collapsed && canCollapse)
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <article
        className={cn(
          'page-card',
          collapsed && 'is-collapsed',
          selected && 'is-selected',
          data.related && 'is-related',
          data.dimmed && 'is-dimmed',
        )}
        data-accent={Array.from(source.id).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4}
        aria-label={source.title}
      >
        <div className="card-domain">
          <span className="domain-icon">
            <Globe2 size={14} />
          </span>
          <span>{source.domain}</span>
          {href && (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="nodrag external-link"
              aria-label={`${source.title} 원문 열기`}
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink size={14} />
            </a>
          )}
        </div>
        <NodeActions id={id} collapsed={collapsed} canCollapse={canCollapse} />
        <h2>{source.title}</h2>
        <div ref={contentRef} className={`page-summary response-content nodrag nopan ${collapsed ? 'nowheel' : ''}`} tabIndex={collapsed ? 0 : undefined}>{source.summary || '요약이 제공되지 않은 자료입니다.'}</div>
        <footer>
          <span className="tag">{source.tag}</span>
          <span>
            {source.content_origin === 'web_search_summary'
              ? 'AI 생성 요약'
              : source.read_status === 'read'
                ? '원문 확인'
                : '요약 기반'}
          </span>
        </footer>
        <PreviousNodeButton id={id} />
      </article>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  )
}
