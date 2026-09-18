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
export type PageNode = Node<{ source: Source; related?: boolean; dimmed?: boolean; collapsed?: boolean; expandedHeight?: number }, 'page'>
export type SourceContent = {
  status: 'reading' | 'summarizing' | 'read' | 'failed' | 'skipped' | 'cancelled'
  text: string
  truncated: boolean
  final_url: string | null
  error_code: 'page_unavailable' | 'page_timeout' | 'budget_exhausted' | 'page_blocked' | 'page_not_found' | 'page_size_limit' | 'unsupported_content_type' | 'unsupported_encoding' | 'empty_page' | 'unsafe_url' | null
  /** Cumulative public summary text, including partial text while summarizing. */
  summary?: string
  summary_error?: 'summary_unavailable' | 'summary_timeout' | 'summary_budget_exhausted' | null
}
export type ToolSource = {
  id: string
  url: string
  title: string
  access: 'search_result' | 'page_read'
  accessed_at: string
  verification: 'unverified'
  image?: { thumbnail_url: string } | null
  page_image?: { thumbnail_url: string } | null
  content?: SourceContent | null
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
export type InformationKind = 'concept' | 'entity' | 'claim' | 'example' | 'comparison' | 'procedure'
export type GroundedText = { text: string; references: TextSpan[] }
export type CardPresentation = {
  heading: string
  summary: GroundedText | null
  sections: { heading: string | null; layout: 'text' | 'bullets' | 'steps'; items: GroundedText[] }[]
  table: { columns: GroundedText[]; rows: (GroundedText | null)[][] } | null
}
export type StructureResult = {
  version: 1 | 2
  text_hash: string
  items: { key: string; subtype: InformationKind; title: TextSpan; excerpt: TextSpan; presentation?: CardPresentation | null }[]
}
export type InformationEntity = {
  id: string
  type: 'information'
  subtype: InformationKind
  responseId: string
  textHash: string
  title: TextSpan
  excerpt: TextSpan
  presentation?: CardPresentation | null
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
  kind: 'has_extract' | 'consulted' | 'cites' | 'uses_context' | 'related_image'
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
export type InformationNode = Node<{ entityId: string; collapsed?: boolean; expandedHeight?: number }, 'information'>
export type SourceNode = Node<{ entityId: string; collapsed?: boolean; expandedHeight?: number }, 'source'>
export type CanvasNode = PageNode | ResponseNode | InformationNode | SourceNode
export type NodeContext = { node_id: string; kind: 'information' | 'source'; title: string; text: string }
export type Session = {
  lastNodeContext?: NodeContext
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

// Shared PostgreSQL history API; revision 0 creates a new record.
export type HistoryWrite = { session: Session; revision: number }
export type HistoryList = { sessions: HistoryWrite[]; next_cursor?: string | null }
export type Revision = { revision: number }
export type ImportResult = { imported: boolean }
