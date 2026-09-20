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
export type Attachment = {
  id: string
  name: string
  kind: 'image' | 'file'
  media_type: string
  size: number
  download_url: string
  preview_url: string | null
  text_excerpt: string
  width: number | null
  height: number | null
  pages: number | null
}
export type AttachmentLimits = { max_bytes: number; max_count: number; max_text_chars: number; max_pdf_pages: number }
export type DraftAttachment = { localId: string; name: string; status: 'uploading' | 'ready' | 'failed'; attachment?: Attachment; error?: string; reused?: boolean }
export type AttachmentNode = Node<{ attachment: Attachment; collapsed?: boolean }, 'attachment'>
export type RequestedTool = 'web_search' | 'read_page'
export type AgentRequest = {
  query: string
  request_id: string
  continuation?: string
  node_context?: NodeContext
  requested_tool?: RequestedTool
  attachment_ids?: string[]
}
export type ResponseNode = Node<
  {
    parentId?: string | null
    continuation?: string
    collapsed?: boolean
    prompt: string
    requestedTool?: RequestedTool
    attachments?: Attachment[]
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
export const ENTITY_KIND_LABELS = {
  concept: '개념', technology: '기술', company: '기업', product: '제품', person: '인물',
  organization: '조직', service: '서비스', software: '소프트웨어', model: '모델',
  standard: '표준', method: '방법', field: '분야', event: '사건', place: '장소',
  country: '국가', work: '작품', material: '소재', species: '생물종', metric: '지표',
  dataset: '데이터셋', policy: '정책', project: '프로젝트', language: '언어', other: '기타',
} as const
export type EntityKind = keyof typeof ENTITY_KIND_LABELS
export type EntityExtract = {
  key: string
  name: string
  subtype: EntityKind
  qualifier: string | null
  aliases: string[]
  role: 'main' | 'related'
  references?: TextSpan[]
  links: { item_key: string; references: TextSpan[] }[]
}
export type SubjectEntity = {
  id: string
  type: 'entity'
  name: string
  subtype: EntityKind
  qualifier: string | null
  aliases: string[]
  observations: { responseId: string; role: 'main' | 'related'; textHash: string; references?: TextSpan[] }[]
}
export type StructureResult = {
  version: 1 | 2 | 3
  text_hash: string
  items: { key: string; subtype: InformationKind; title: TextSpan; excerpt: TextSpan; presentation?: CardPresentation | null }[]
  entities?: EntityExtract[]
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
  kind: 'has_extract' | 'consulted' | 'cites' | 'uses_context' | 'related_image' | 'about' | 'has_entity' | 'has_information'
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
  entities: Record<string, InformationEntity | SourceEntity | SubjectEntity>
  relations: ContentRelation[]
  jobs: Record<string, StructureJob>
}
export type InformationNode = Node<{
  entityId: string
  collapsed?: boolean
  expandedHeight?: number
}, 'information'>
export type SourceNode = Node<{ entityId: string; collapsed?: boolean; expandedHeight?: number }, 'source'>
export type EntityNode = Node<{ entityId: string; collapsed?: boolean }, 'entity'>
export type UserNodeData = { kind: 'response' | 'entity' | 'information' | 'source' | 'image'; title: string; text: string; url: string; imageUrl: string; collapsed?: boolean; label?: string; attachment?: Attachment; page?: Source; presentation?: CardPresentation | null; entitySubtype?: EntityKind; qualifier?: string | null; aliases?: string[] }
export type UserNode = Node<UserNodeData, 'user'>
export type UserEdge = { id: string; source: string; target: string; label: string; sourceHandle?: string | null; targetHandle?: string | null }
export type CanvasEdits = {
  nodes: UserNode[]
  hiddenNodes: string[]
  edges: UserEdge[]
  hiddenEdges: string[]
  positions: Record<string, { x: number; y: number }>
}
export type CanvasNode = UserNode | AttachmentNode | PageNode | ResponseNode | InformationNode | SourceNode | EntityNode
export type NodeContext = { node_id: string; kind: 'information' | 'source' | 'entity'; title: string; text: string }
export type ResponseTiming = {
  responseId?: string
  startedAt: number
  durationMs?: number
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
}
export type Session = {
  /** Local shared-view flag; never used as a server authorization mechanism. */
  readOnly?: boolean
  canvasEdits?: CanvasEdits
  responseTimings?: Record<string, ResponseTiming>
  lastNodeContext?: NodeContext
  id: string
  query: string
  title?: string
  titleRequested?: boolean
  lastParentId?: string | null
  lastQuery?: string
  lastRequestedTool?: RequestedTool
  lastAttachments?: Attachment[]
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

export type ShareCreated = { id: string }
export type SharedCanvas = { session: Session }
