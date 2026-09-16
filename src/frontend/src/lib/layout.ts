import { forceSimulation, forceX, forceY, forceCollide, forceLink, type SimulationNodeDatum, type SimulationLinkDatum } from 'd3-force'
import type { Graph, PageNode, Source } from '../types'
export const CARD_WIDTH = 280
export const CARD_HEIGHT = 206
interface Particle extends SimulationNodeDatum { id: string; cluster: number; x: number; y: number }
export function layoutPages(sources: Source[], existing: PageNode[], graph: Graph, focusId?: string): PageNode[] {
  const old = new Map(existing.map(n => [n.id, n]))
  const fresh = sources.filter(s => !old.has(s.id))
  if (!fresh.length) return sources.map(s => ({ ...old.get(s.id)!, data: { source: s } }))
  const groups = new Map(graph.clusters.flatMap((c, i) => c.source_ids.map(id => [id, i] as const)))
  const anchor = existing.find(n => n.id === focusId)
  const baseX = anchor ? anchor.position.x + 420 : existing.length ? Math.max(...existing.map(n => n.position.x)) + 420 : 0
  const baseY = anchor?.position.y ?? 0
  const particles: Particle[] = sources.map((s, i) => {
    const node = old.get(s.id)
    const cluster = groups.get(s.id) ?? Math.floor(i / 2)
    return node
      ? { id: s.id, cluster, x: node.position.x, y: node.position.y, fx: node.position.x, fy: node.position.y }
      : { id: s.id, cluster, x: baseX + cluster * 420, y: baseY + (i % 2) * 290 }
  })
  const ids = new Set(particles.map(n => n.id))
  const links: SimulationLinkDatum<Particle>[] = graph.relations.filter(e => ids.has(e.source) && ids.has(e.target)).map(e => ({ source: e.source, target: e.target }))
  const sim = forceSimulation(particles)
    .force('x', forceX<Particle>(n => baseX + n.cluster * 420).strength(0.55))
    .force('y', forceY<Particle>(n => baseY + (sources.findIndex(s => s.id === n.id) % 2) * 290).strength(0.3))
    .force('collision', forceCollide<Particle>(185).iterations(3))
    .force('links', forceLink<Particle, SimulationLinkDatum<Particle>>(links).id(n => n.id).distance(380).strength(0.08))
    .stop()
  sim.tick(180)
  // Final rectangle pass guarantees no overlap, including against user-pinned cards.
  const placed = existing.map(n => ({ x: n.position.x, y: n.position.y }))
  const positions = new Map<string, { x: number; y: number }>()
  for (const p of particles.filter(p => !old.has(p.id))) {
    let x = Math.round(p.x), y = Math.round(p.y)
    let attempts = 0
    while (placed.some(q => Math.abs(q.x - x) < CARD_WIDTH + 50 && Math.abs(q.y - y) < CARD_HEIGHT + 50)) {
      y += CARD_HEIGHT + 65
      if (++attempts % 4 === 0) { x += CARD_WIDTH + 130; y = baseY }
    }
    placed.push({ x, y }); positions.set(p.id, { x, y })
  }
  return sources.map(s => ({ ...(old.get(s.id) ?? { id: s.id, type: 'page' as const, position: positions.get(s.id)!, width: CARD_WIDTH, height: CARD_HEIGHT }), data: { source: s } }))
}
