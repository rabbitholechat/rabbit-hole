import type { Session, StructureResult } from '../../src/types'

export const entityAnswer = '벡터 서치는 검색 기술입니다.\n벡터 서치는 검색 기술로 의미를 비교합니다.'
export function entityResult(hash: string): StructureResult {
  const lines = entityAnswer.split('\n')
  const spans = lines.map((quote, i) => ({ start: i ? lines[0].length + 1 : 0, end: i ? entityAnswer.length : quote.length, quote }))
  return {
    version: 3, text_hash: hash,
    items: spans.map((span, i) => ({
      key: String(i + 1).repeat(24), subtype: 'concept', title: span, excerpt: span,
      presentation: { heading: i ? '의미 비교' : '검색 기술의 정의', summary: { text: span.quote, references: [span] }, sections: [], table: null },
    })),
    entities: [{ key: 'a'.repeat(24), name: '벡터 서치', subtype: 'technology', qualifier: '검색 기술',
      aliases: [], role: 'main', links: spans.map((span, i) => ({ item_key: String(i + 1).repeat(24), references: [span] })) }],
  }
}
export function entitySession(): Session {
  return { id: 'entity-session', query: '벡터 서치', updatedAt: 1, mode: 'live', protocol: 2,
    nodes: [{ id: 'response_entity', type: 'response', position: { x: 0, y: 0 }, width: 560,
      data: { text: entityAnswer, prompt: '벡터 서치를 알려줘', status: 'completed' } }],
    sources: [], graph: { relations: [], clusters: [] }, answer: null, viewport: { x: 0, y: 0, zoom: 0.8 },
    fitted: true, pinned: [], status: 'completed', failedParts: [] }
}
