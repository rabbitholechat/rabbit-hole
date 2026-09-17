import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Root, RootContent } from 'mdast'
import type {
  CanvasNode,
  ContentGraph,
  ContentRelation,
  ResponseNode,
  Session,
  StructureResult,
  TextSpan,
  SourceEntity,
} from '../types'
import { safeUrl } from './utils'

export const emptyContentGraph = (): ContentGraph => ({ version: 1, entities: {}, relations: [], jobs: {} })
export const responseById = (session: Session, id: string) =>
  session.nodes.find((n): n is ResponseNode => n.type === 'response' && n.id === id)
export async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
function normalizeUrl(raw: string) {
  const safe = safeUrl(raw)
  if (!safe) return
  const url = new URL(safe)
  url.hash = ''
  // Only known tracking parameters; document IDs, language and other query values remain distinct.
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || /^(fbclid|gclid|dclid|msclkid|srsltid|yclid|mc_cid|mc_eid|_ga|_gl)$/i.test(key)) url.searchParams.delete(key)
  }
  url.searchParams.sort()
  return url.href
}
export function markdownLinks(text: string): { url: string; span: TextSpan }[] {
  const root = unified().use(remarkParse).use(remarkGfm).parse(text)
  const definitions = new Map<string, string>()
  const links: { url: string; span: TextSpan }[] = []
  const walk = (node: Root | RootContent, visit: (node: Root | RootContent) => void) => {
    visit(node)
    if ('children' in node) node.children.forEach((child) => walk(child, visit))
  }
  walk(root, (node) => {
    if (node.type === 'definition') definitions.set(node.identifier, node.url)
  })
  walk(root, (node) => {
    const raw =
      node.type === 'link'
        ? node.url
        : node.type === 'linkReference'
          ? definitions.get(node.identifier)
          : undefined
    const url = raw && normalizeUrl(raw)
    const start = node.position?.start.offset,
      end = node.position?.end.offset
    if (url && start !== undefined && end !== undefined)
      links.push({
        url,
        span: {
          start: Array.from(text.slice(0, start)).length,
          end: Array.from(text.slice(0, end)).length,
          quote: text.slice(start, end),
        },
      })
  })
  return links
}
function relation(
  source: string,
  target: string,
  kind: ContentRelation['kind'],
  responseId: string,
  spans: TextSpan[],
): ContentRelation {
  return { id: `${kind}:${source}:${target}`, source, target, kind, responseId, spans }
}
function withRelations(graph: ContentGraph, extra: ContentRelation[]) {
  return [...new Map([...graph.relations, ...extra].map((r) => [r.id, r])).values()]
}
function place(session: Session, ids: string[], response: ResponseNode): CanvasNode[] {
  const nodes = [...session.nodes]
  for (const id of ids) {
    if (nodes.some((n) => n.id === id)) continue
    const entity = session.contentGraph!.entities[id]
    const width = entity.type === 'information' ? 340 : 460
    const height = entity.type === 'source' ? 260 : 280
    const x =
      response.position.x +
      (response.measured?.width ?? response.width ?? 560) +
      88 +
      (entity.type === 'source' ? 428 : 0)
    let y = response.position.y
    while (true) {
      const collisions = nodes.filter(
        (n) =>
          x < n.position.x + (n.measured?.width ?? n.width ?? 560) + 32 &&
          x + width + 32 > n.position.x &&
          y < n.position.y + (n.measured?.height ?? n.height ?? 400) + 32 &&
          y + height + 32 > n.position.y,
      )
      if (!collisions.length) break
      y = Math.max(...collisions.map((n) => n.position.y + (n.measured?.height ?? n.height ?? 400))) + 48
    }
    nodes.push({ id, type: entity.type, data: { entityId: id }, position: { x, y }, width, ...(entity.type === 'source' ? { height } : {}) })
  }
  return nodes
}

function mergeSource(kept: SourceEntity, incoming: SourceEntity): SourceEntity {
  const observations = new Map(kept.observations.map((o) => [o.responseId, o]))
  for (const next of incoming.observations) {
    const old = observations.get(next.responseId)
    const preferred = old?.access === 'page_read' && next.access === 'search_result' ? old : next
    const spans = [...new Map([...(old?.spans ?? []), ...next.spans].map((s) => [`${s.start}:${s.end}`, s])).values()]
    observations.set(next.responseId, { ...preferred, spans })
  }
  const source = kept.source.access === 'page_read' ? kept.source : incoming.source
  return { ...kept, source: { ...source, id: kept.id }, observations: [...observations.values()] }
}

// Keep the first displayed card and its placement; retarget all references to that card.
export function deduplicateSources(session: Session): Session {
  const graph = session.contentGraph
  if (!graph) return session
  const entities = { ...graph.entities }
  const byUrl = new Map<string, string>(), aliases = new Map<string, string>()
  const ids = [...new Set([...session.nodes.map((n) => n.id), ...Object.keys(entities)])]
  for (const id of ids) {
    const entity = entities[id]
    if (entity?.type !== 'source') continue
    const url = normalizeUrl(entity.source.url)
    if (!url) continue
    const keptId = byUrl.get(url)
    if (!keptId) { byUrl.set(url, id); continue }
    entities[keptId] = mergeSource(entities[keptId] as SourceEntity, entity)
    delete entities[id]
    aliases.set(id, keptId)
  }
  if (!aliases.size) return session
  const edges = new Map<string, ContentRelation>()
  for (const edge of graph.relations) {
    const source = aliases.get(edge.source) ?? edge.source
    const target = aliases.get(edge.target) ?? edge.target
    const key = `${source}:${target}:${['has_extract', 'uses_context'].includes(edge.kind) ? edge.kind : 'source'}`
    const old = edges.get(key)
    const spans = [...new Map([...(old?.spans ?? []), ...edge.spans].map((s) => [`${s.start}:${s.end}`, s])).values()]
    const kind = old?.kind === 'cites' || edge.kind === 'cites' ? 'cites' : edge.kind
    edges.set(key, relation(source, target, kind, edge.responseId, spans))
  }
  return {
    ...session,
    nodes: session.nodes.filter((n) => !aliases.has(n.id)).map((node) =>
      node.type === 'response' && node.data.parentId && aliases.has(node.data.parentId)
        ? { ...node, data: { ...node.data, parentId: aliases.get(node.data.parentId)! } } : node,
    ),
    lastParentId: session.lastParentId ? aliases.get(session.lastParentId) ?? session.lastParentId : session.lastParentId,
    lastNodeContext: session.lastNodeContext
      ? { ...session.lastNodeContext, node_id: aliases.get(session.lastNodeContext.node_id) ?? session.lastNodeContext.node_id }
      : undefined,
    pinned: [...new Set(session.pinned.map((id) => aliases.get(id) ?? id))],
    contentGraph: { ...graph, entities, relations: [...edges.values()] },
  }
}

// Retrieval metadata is deterministic and requires no model call, including on legacy v2 restore.
export function attachSources(session: Session, responseId: string): Session {
  session = deduplicateSources(session)
  const response = responseById(session, responseId)
  if (!response || !response.data.toolSources?.length || response.data.status === 'streaming') return session
  const graph = session.contentGraph ?? emptyContentGraph()
  const entities = { ...graph.entities },
    extra: ContentRelation[] = [],
    ids: string[] = []
  const links = markdownLinks(response.data.text)
  for (const source of response.data.toolSources) {
    if (!normalizeUrl(source.url)) continue
    const spans = links.filter((link) => link.url === normalizeUrl(source.url)).map((link) => link.span)
    const existing = Object.values(entities).find(
      (e) => e.type === 'source' && normalizeUrl(e.source.url) === normalizeUrl(source.url),
    )
    const id = existing?.id ?? source.id
    const old = entities[id]
    if (old && old.type !== 'source') continue
    const observation = { responseId, access: source.access, accessedAt: source.accessed_at, spans }
    const incoming: SourceEntity = {
      id,
      type: 'source',
      source: { ...source, id },
      observations: [observation],
    }
    entities[id] = old ? mergeSource(old, incoming) : incoming
    ids.push(id)
    extra.push(relation(responseId, id, spans.length ? 'cites' : 'consulted', responseId, spans))
  }
  const next = {
    ...session,
    contentGraph: {
      ...graph,
      entities,
      relations: withRelations(
        {
          ...graph,
          relations: graph.relations.filter(
            (r) =>
              !(r.source === responseId && ids.includes(r.target) && ['cites', 'consulted'].includes(r.kind)),
          ),
        },
        extra,
      ),
    },
  }
  return { ...next, nodes: place(next, ids, response) }
}

export function validateStructure(value: unknown, text: string, hash: string): StructureResult {
  const data = value as StructureResult
  const chars = Array.from(text)
  const checkSpan = (span: TextSpan, max: number) =>
    span &&
    Number.isInteger(span.start) &&
    Number.isInteger(span.end) &&
    span.start >= 0 &&
    span.end > span.start &&
    span.end <= chars.length &&
    typeof span.quote === 'string' &&
    span.quote.length <= max &&
    chars.slice(span.start, span.end).join('') === span.quote
  if (
    !data ||
    data.version !== 1 ||
    data.text_hash !== hash ||
    !Array.isArray(data.items) ||
    data.items.length > 6
  )
    throw Error('invalid_structure')
  const seen = new Set<string>()
  for (const item of data.items) {
    if (
      !item ||
      !/^[a-f0-9]{24}$/.test(item.key) ||
      seen.has(item.key) ||
      !['concept', 'entity', 'claim', 'example', 'comparison'].includes(item.subtype) ||
      !checkSpan(item.title, 200) ||
      !checkSpan(item.excerpt, 12000) ||
      item.title.start < item.excerpt.start ||
      item.title.end > item.excerpt.end ||
      item.excerpt.quote.trim() === text.trim()
    )
      throw Error('invalid_structure')
    seen.add(item.key)
  }
  return data
}
export function attachInformation(session: Session, responseId: string, result: StructureResult): Session {
  const response = responseById(session, responseId)
  if (!response) return session
  const graph = session.contentGraph ?? emptyContentGraph()
  const entities = { ...graph.entities },
    extra: ContentRelation[] = [],
    ids: string[] = []
  for (const item of result.items) {
    const id = `info_${responseId}_${item.key}`
    entities[id] = {
      id,
      type: 'information',
      subtype: item.subtype,
      responseId,
      textHash: result.text_hash,
      title: item.title,
      excerpt: item.excerpt,
    }
    ids.push(id)
    extra.push(relation(responseId, id, 'has_extract', responseId, [item.excerpt]))
    const links = markdownLinks(response.data.text).filter(
      (link) => link.span.start >= item.excerpt.start && link.span.end <= item.excerpt.end,
    )
    for (const entity of Object.values(entities)) {
      if (entity.type !== 'source') continue
      const spans = links
        .filter((l) => l.url === normalizeUrl(entity.source.url))
        .map((l) => l.span)
      if (spans.length) extra.push(relation(id, entity.id, 'cites', responseId, spans))
    }
  }
  const next = { ...session, contentGraph: { ...graph, entities, relations: withRelations(graph, extra) } }
  return { ...next, nodes: place(next, ids, response) }
}
