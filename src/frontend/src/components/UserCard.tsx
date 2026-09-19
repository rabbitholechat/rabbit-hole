import type { NodeProps } from '@xyflow/react'
import type { UserNode } from '../types'
import { ResponseCard } from './ResponseCard'
import { EntityCard } from './EntityCard'
import { ContentCard } from './ContentCard'
import { AttachmentCard } from './AttachmentCard'
import { PageCard } from './PageCard'

// Copies and edits reuse the original card components. Only provenance and actions differ.
export function UserCard(props: NodeProps<UserNode>) {
  const data = props.data
  if (data.attachment) return <AttachmentCard {...props} type="attachment" data={{ attachment: data.attachment, collapsed: data.collapsed }} />
  if (data.page) return <PageCard {...props} type="page" data={{ source: data.page, collapsed: data.collapsed }} />
  if (data.kind === 'response') return <ResponseCard {...props} type="response" edited displayLabel={data.label}
    data={{ prompt: data.title, text: data.text, collapsed: data.collapsed, status: 'completed' }} />
  if (data.kind === 'entity') return <EntityCard {...props} type="entity" display={data}
    data={{ entityId: props.id, collapsed: data.collapsed }} />
  return <ContentCard {...props} type={data.kind === 'information' ? 'information' : 'source'} display={data}
    data={{ entityId: props.id, collapsed: data.collapsed }} />
}
