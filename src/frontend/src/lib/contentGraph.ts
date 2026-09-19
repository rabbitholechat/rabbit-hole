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
  EntityExtract,
  SubjectEntity,
} from '../types'
import { safeUrl } from './utils'
import { cardReferences, validPresentation } from './information'

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
function estimatedHeight(session: Session, node: CanvasNode) {
  if (node.measured?.height ?? node.height) return node.measured?.height ?? node.height!
  const entity = session.contentGraph?.entities[node.id]
  return entity?.type === 'entity' ? 220 : entity?.type === 'source' ? (entity.source.image ? 440 : entity.source.content && !['failed', 'skipped'].includes(entity.source.content.status) ? 480 : 260) : 400
}
function place(session: Session, ids: string[], response: ResponseNode): CanvasNode[] {
  const nodes = [...session.nodes]
  for (const id of ids) {
    if (nodes.some((n) => n.id === id)) continue
    const entity = session.contentGraph!.entities[id]
    const width = entity.type === 'entity' ? 210 : entity.type === 'information' ? (entity.presentation?.table ? 460 : 340) : 460
    const height = entity.type === 'entity' ? 220 : entity.type === 'source' ? (entity.source.image ? 440 : entity.source.content && !['failed', 'skipped'].includes(entity.source.content.status) ? 480 : 260) : 280
    const imageParentId = session.contentGraph!.relations.find((r) => r.kind === 'related_image' && r.target === id)?.source
    const imageParent = nodes.find((n) => n.id === imageParentId)
    const parentIds = session.contentGraph!.relations.filter((r) => r.kind === 'has_information' && r.target === id).map((r) => r.source)
    const subjectParents = nodes.filter((n) => parentIds.includes(n.id))
    const hasSubjects = session.contentGraph!.relations.some((r) => r.kind === 'has_entity' && r.source === response.id)
    const baseX = imageParent ? imageParent.position.x + (imageParent.measured?.width ?? imageParent.width ?? 460) + 88 :
      response.position.x +
      (response.measured?.width ?? response.width ?? 560) +
      88 +
      (entity.type === 'information' && hasSubjects ? 298 : entity.type === 'source' ? 846 + (entity.source.image ? 460 + 88 : 0) : 0)
    const x = Math.max(baseX, ...subjectParents.map((n) => n.position.x + (n.measured?.width ?? n.width ?? 210) + 88))
    let y = imageParent?.position.y ?? (subjectParents.length ? Math.max(response.position.y, subjectParents[0].position.y) : response.position.y)
    while (true) {
      const collisions = nodes.filter(
        (n) =>
          x < n.position.x + (n.measured?.width ?? n.width ?? 560) + 32 &&
          x + width + 32 > n.position.x &&
          y < n.position.y + estimatedHeight(session, n) + 32 &&
          y + height + 32 > n.position.y,
      )
      if (!collisions.length) break
      y = Math.max(...collisions.map((n) => n.position.y + estimatedHeight(session, n))) + 48
    }
    nodes.push({ id, type: entity.type, data: { entityId: id, ...(['source', 'entity'].includes(entity.type) ? { collapsed: true } : {}) }, position: { x, y }, width })
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
  const source = kept.source.content?.status === 'read' && !incoming.source.content?.text
    ? kept.source
    : incoming.source.content ? incoming.source
      : kept.source.access === 'page_read' ? kept.source : incoming.source
  return { ...kept, source: { ...source, image: incoming.source.image ?? kept.source.image, id: kept.id }, observations: [...observations.values()] }
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
    const normalized = normalizeUrl(entity.source.url)
    if (!normalized) continue
    const url = normalized + (entity.source.image ? ":image" : ":page")
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
    const key = `${source}:${target}:${['has_extract', 'uses_context', 'related_image', 'about', 'has_entity', 'has_information'].includes(edge.kind) ? edge.kind : 'source'}`
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
      (e) => e.type === 'source' && !!e.source.image === !!source.image && normalizeUrl(e.source.url) === normalizeUrl(source.url),
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
    if (source.page_image && !source.image) {
      const imageId = `image_${id}`
      const imageEntity: SourceEntity = {
        id: imageId, type: 'source',
        source: { ...source, id: imageId, image: source.page_image, page_image: undefined, content: undefined },
        observations: [{ ...observation, spans: [] }],
      }
      const previous = entities[imageId]
      entities[imageId] = previous?.type === 'source' ? mergeSource(previous, imageEntity) : imageEntity
      ids.push(imageId)
      extra.push(relation(id, imageId, 'related_image', responseId, []))
    }
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
    Array.from(span.quote).length <= max &&
    chars.slice(span.start, span.end).join('') === span.quote
  if (
    !data ||
    ![1, 2, 3].includes(data.version) ||
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
      !['concept', 'entity', 'claim', 'example', 'comparison', 'procedure'].includes(item.subtype) ||
      !checkSpan(item.title, 200) ||
      !checkSpan(item.excerpt, 12000) ||
      item.title.start < item.excerpt.start ||
      item.title.end > item.excerpt.end ||
      (data.version === 1 && (item.excerpt.quote.trim() === text.trim() || item.presentation != null)) ||
      (data.version >= 2 && !validPresentation(item.presentation, checkSpan))
    )
      throw Error('invalid_structure')
    seen.add(item.key)
  }
  if (data.version !== 3) return data
  // Entity failure must not discard valid cards. Never accept ungrounded labels or dangling links.
  const candidates = Array.isArray(data.entities) ? data.entities.slice(0, 4) : []
  const entities = candidates.flatMap((entity): EntityExtract[] => {
    if (!entity || !/^[a-f0-9]{24}$/.test(entity.key) || typeof entity.name !== 'string' ||
      !entity.name.trim() || entity.name.length > 100 ||
      !['concept', 'technology', 'company', 'product', 'person'].includes(entity.subtype) ||
      !['main', 'related'].includes(entity.role) || !Array.isArray(entity.aliases) || entity.aliases.length > 3 ||
      !(entity.qualifier === null || (typeof entity.qualifier === 'string' && !!entity.qualifier.trim() && entity.qualifier.length <= 100)) ||
      !Array.isArray(entity.links) || !entity.links.length || entity.links.length > 6) return []
    const links = entity.links.filter((link) => {
      const item = data.items.find((item) => item.key === link?.item_key)
      if (!item || !Array.isArray(link.references) || !link.references.length || link.references.length > 4) return false
      const anchors = item.presentation ? cardReferences(item.presentation) : [item.excerpt]
      return link.references.every((ref) => checkSpan(ref, 6000) && anchors.some((a) => ref.start >= a.start && ref.end <= a.end))
    })
    if (!links.length) return []
    const references = entity.references ?? links.flatMap((link) => link.references).slice(0, 4)
    if (!Array.isArray(references) || !references.length || references.length > 4 || !references.every((ref) => checkSpan(ref, 6000))) return []
    const quotes = references.map((ref) => ref.quote).join('\n')
    return quotes.includes(entity.name) && (entity.qualifier === null || quotes.includes(entity.qualifier)) &&
      entity.aliases.every((alias) => typeof alias === 'string' && !!alias.trim() && alias.length <= 100 && quotes.includes(alias))
      ? [{ ...entity, references, links }] : []
  })
  return { ...data, entities }
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
      ...(item.presentation ? { presentation: item.presentation } : {}),
    }
    ids.push(id)
    const references = item.presentation ? cardReferences(item.presentation) : [item.excerpt]
    extra.push(relation(responseId, id, 'has_extract', responseId, references))
    const links = markdownLinks(response.data.text).filter(
      (link) => references.some((ref) => link.span.start >= ref.start && link.span.end <= ref.end),
    )
    for (const entity of Object.values(entities)) {
      if (entity.type !== 'source' || entity.id.startsWith('image_')) continue
      const spans = links
        .filter((l) => l.url === normalizeUrl(entity.source.url))
        .map((l) => l.span)
      if (spans.length) extra.push(relation(id, entity.id, 'cites', responseId, spans))
    }
  }
  const next = { ...session, contentGraph: { ...graph, entities, relations: withRelations(graph, extra) } }
  const withEntities = attachEntities(next, responseId, result)
  return { ...withEntities, nodes: place(withEntities, ids, response) }
}

function attachEntities(session: Session, responseId: string, result: StructureResult): Session {
  const response = responseById(session, responseId)
  if (!response || result.version !== 3 || !result.entities?.length) return session
  const graph = session.contentGraph!
  const entities = { ...graph.entities }, extra: ContentRelation[] = [], ids: string[] = []
  const normalize = (value: string) => value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
  for (const subject of result.entities) {
    const ownId = `entity_${responseId}_${subject.key}`
    const existing = Object.values(entities).find((entry): entry is SubjectEntity => {
      if (entry.type !== 'entity' || entry.subtype !== subject.subtype) return false
      if (entry.id === ownId) return true
      // Unqualified labels may be homonyms. Only reuse grounded, matching qualified identities.
      if (!entry.qualifier || !subject.qualifier || normalize(entry.qualifier) !== normalize(subject.qualifier)) return false
      const names = [entry.name, ...entry.aliases].map(normalize)
      return [subject.name, ...subject.aliases].some((name) => names.includes(normalize(name)))
    })
    const id = existing?.id ?? ownId
    const observation = { responseId, role: subject.role, textHash: result.text_hash,
      references: subject.references ?? subject.links.flatMap((link) => link.references).slice(0, 4) }
    entities[id] = {
      id, type: 'entity', name: existing?.name ?? subject.name, subtype: subject.subtype,
      qualifier: subject.qualifier,
      aliases: [...new Set([...(existing?.aliases ?? []), ...subject.aliases, ...(existing && existing.name !== subject.name ? [subject.name] : [])])],
      observations: [...(existing?.observations ?? []).filter((o) => o.responseId !== responseId), observation],
    }
    ids.push(id)
    extra.push(relation(responseId, id, 'has_entity', responseId, observation.references))
    for (const link of subject.links) {
      const informationId = `info_${responseId}_${link.item_key}`
      if (entities[informationId]?.type === 'information')
        extra.push(relation(id, informationId, 'has_information', responseId, link.references))
    }
  }
  const next = { ...session, contentGraph: { ...graph, entities, relations: withRelations(graph, extra) } }
  return { ...next, nodes: place(next, ids, response) }
}
