import type { Node, Viewport } from '@xyflow/react'
export type Source = {
  id: string; original_url: string; url: string; title: string; domain: string; summary: string
  excerpt: string; published_at: string | null; retrieved_at: string
  read_status: 'summary' | 'read' | 'failed'; tag: string
}
export type Evidence = { source_id: string; quote: string; basis: 'summary' | 'excerpt' }
export type Answer = { claims: { text: string; evidence: Evidence[] }[]; limitation: string }
export type Relation = {
  source: string; target: string; kind: string; label: string; explanation: string
  evidence: Evidence[]; strength: 'core' | 'weak'
}
export type Graph = { relations: Relation[]; clusters: { id: string; label: string; source_ids: string[] }[] }
export type PageNode = Node<{ source: Source; related?: boolean; dimmed?: boolean }, 'page'>
export type Flight = {
  origin: string; departure: string; return_date: string | null; trip: 'one_way' | 'round_trip'
  passengers: number; direct: boolean; baggage: 'none' | 'cabin' | 'checked'
}
export type Session = {
  id: string; query: string; updatedAt: number; mode: 'live' | 'sample'
  sources: Source[]; nodes: PageNode[]; graph: Graph; answer: Answer | null
  viewport: Viewport; fitted: boolean; pinned: string[]; continuation?: string
  status: 'idle' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'
  failedParts: string[]; flight?: Flight
}
export type Envelope = {
  version: 1; request_id: string; job_id: string; seq: number; type: string
  data: Record<string, unknown>
}
