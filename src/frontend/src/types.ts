import type { Node, Viewport } from '@xyflow/react'
export type Source = {
  id: string
  original_url: string
  url: string
  title: string
  domain: string
  summary: string
  content_origin?: 'search_snippet' | 'web_search_summary'
  excerpt: string
  published_at: string | null
  retrieved_at: string
  read_status: 'summary' | 'read' | 'failed'
  tag: string
}
export type Evidence = { source_id: string; quote: string; basis: 'summary' | 'excerpt' }
export type Answer = { claims: { text: string; evidence: Evidence[] }[]; limitation: string }
export type Relation = {
  source: string
  target: string
  kind: string
  label: string
  explanation: string
  evidence: Evidence[]
  strength: 'core' | 'weak'
}
export type Graph = { relations: Relation[]; clusters: { id: string; label: string; source_ids: string[] }[] }
export type PageNode = Node<{ source: Source; related?: boolean; dimmed?: boolean }, 'page'>
export type ToolSource = {
  id: string
  url: string
  title: string
  access: 'search_result' | 'page_read'
  accessed_at: string
  verification: 'unverified'
}
export type ResponseNode = Node<
  {
    parentId?: string | null
    continuation?: string
    collapsed?: boolean
    prompt: string
    text: string
    toolSources?: ToolSource[]
    status: 'streaming' | 'completed' | 'partial' | 'failed' | 'cancelled'
  },
  'response'
>
export type TextSpan = { start: number; end: number; quote: string }
export type InformationKind = 'concept' | 'entity' | 'claim' | 'example' | 'comparison'
export type StructureResult = {
  version: 1
  text_hash: string
  items: { key: string; subtype: InformationKind; title: TextSpan; excerpt: TextSpan }[]
}
export type InformationEntity = {
  id: string
  type: 'information'
  subtype: InformationKind
  responseId: string
  textHash: string
  title: TextSpan
  excerpt: TextSpan
}
export type SourceEntity = {
  id: string
  type: 'source'
  source: ToolSource
  observations: { responseId: string; access: ToolSource['access']; accessedAt: string; spans: TextSpan[] }[]
}
export type ContentRelation = {
  id: string
  source: string
  target: string
  kind: 'has_extract' | 'consulted' | 'cites'
  responseId: string
  spans: TextSpan[]
}
export type StructureJob = {
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  attemptId: string
  textHash?: string
  error?: string
}
export type ContentGraph = {
  version: 1
  entities: Record<string, InformationEntity | SourceEntity>
  relations: ContentRelation[]
  jobs: Record<string, StructureJob>
}
export type InformationNode = Node<{ entityId: string }, 'information'>
export type SourceNode = Node<{ entityId: string }, 'source'>
export type CanvasNode = PageNode | ResponseNode | InformationNode | SourceNode
export type Session = {
  id: string
  query: string
  title?: string
  titleRequested?: boolean
  lastParentId?: string | null
  lastQuery?: string
  updatedAt: number
  mode: 'live' | 'sample'
  protocol?: 2
  sources: Source[]
  nodes: CanvasNode[]
  graph: Graph
  contentGraph?: ContentGraph
  answer: Answer | null
  viewport: Viewport
  fitted: boolean
  pinned: string[]
  continuation?: string
  status: 'idle' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'awaiting_input'
  failedParts: string[]
}
export type Envelope = {
  version: 2
  request_id: string
  job_id: string
  seq: number
  type: string
  data: Record<string, unknown>
}

export type PartError = {
  part: 'response'
  code?: string
  message: string
}
