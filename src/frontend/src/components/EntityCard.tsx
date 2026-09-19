import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useStore } from '../store'
import { ENTITY_KIND_LABELS, type EntityNode } from '../types'
import { NodeTag } from './NodeTag'
import { entityInformationIds, nodeLabel } from '../lib/nodeActions'
import { PreviousNodeButton } from './PreviousNodeButton'
import { NodeActions } from './NodeActions'

export function EntityCard({ id, data, selected }: NodeProps<EntityNode>) {
  const session = useStore((s) => s.session)
  const navigate = useStore((s) => s.navigateTo)
  const replyTo = useStore((s) => s.replyTo)
  const entity = session?.contentGraph?.entities[data.entityId]
  if (entity?.type !== 'entity') return null
  const informationIds = entityInformationIds(session, id)
  const canExpand = Boolean(informationIds.length || entity.qualifier || entity.aliases.length)
  return <>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <article className={`entity-card ${selected ? 'is-selected' : ''} ${replyTo === id ? 'is-reply-target' : ''}`} aria-label={`엔티티 · ${entity.name}`}>
      <header><NodeTag kind="entity" /><small className="entity-type">{ENTITY_KIND_LABELS[entity.subtype] ?? '기타'}</small>
        <NodeActions id={id} collapsed={data.collapsed} canCollapse={canExpand} /></header>
      <h2>{entity.name}</h2>
      <p className="entity-count">관련 정보 {informationIds.length}</p>
      {!data.collapsed && entity.qualifier && <p className="entity-qualifier">{entity.qualifier}</p>}
      {!data.collapsed && entity.aliases.length > 0 && <p className="entity-qualifier">{entity.aliases.join(' · ')}</p>}
      {!data.collapsed && <ul className="entity-information nodrag nopan nowheel" aria-label="관련 정보">
        {informationIds.map((informationId) => <li key={informationId}>
          <button onClick={(event) => { event.stopPropagation(); navigate(informationId) }}>{nodeLabel(session, informationId)}</button>
        </li>)}
      </ul>}
      <footer className="node-footer"><button className="node-button nodrag nopan" disabled={!informationIds.length} onClick={() => navigate(informationIds[0])}>관련 정보로</button><PreviousNodeButton id={id} /></footer>
    </article>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </>
}
