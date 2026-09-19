import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useStore } from '../store'
import type { EntityNode } from '../types'
import { NodeTag } from './NodeTag'
import { nodeLabel } from '../lib/nodeActions'

const labels = { concept: '개념', technology: '기술', company: '기업', product: '제품', person: '인물' }

export function EntityCard({ id, data, selected }: NodeProps<EntityNode>) {
  const session = useStore((s) => s.session)
  const navigate = useStore((s) => s.navigateTo)
  const toggle = useStore((s) => s.toggleNode)
  const entity = session?.contentGraph?.entities[data.entityId]
  if (entity?.type !== 'entity') return null
  const informationIds = [...new Set(session?.contentGraph?.relations
    .filter((edge) => edge.kind === 'about' && edge.target === id).map((edge) => edge.source))]
  const main = entity.observations.some((observation) => observation.role === 'main')
  return <>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <article className={`entity-card ${selected ? 'is-selected' : ''}`} aria-label={`엔티티 · ${entity.name}`}>
      <header><NodeTag kind="entity" /><small>{labels[entity.subtype]}</small></header>
      <h2>{entity.name}</h2>
      {entity.qualifier && <p className="entity-qualifier">{entity.qualifier}</p>}
      {main && <small className="entity-role" title="연결된 응답 중 중심 대상으로 설명된 응답이 있습니다">중심으로 다룬 응답 있음</small>}
      <button className="node-button nodrag nopan" aria-expanded={!data.collapsed}
        onClick={(event) => { event.stopPropagation(); toggle(id) }}>
        관련 정보 {informationIds.length} {data.collapsed ? '보기' : '접기'}
      </button>
      {!data.collapsed && <ul className="entity-information nodrag nopan nowheel" aria-label="관련 정보">
        {informationIds.map((informationId) => <li key={informationId}>
          <button onClick={(event) => { event.stopPropagation(); navigate(informationId) }}>{nodeLabel(session, informationId)}</button>
        </li>)}
      </ul>}
    </article>
  </>
}
