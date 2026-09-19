import { EditableNodeContent } from './CanvasEditor'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useStore } from '../store'
import { ENTITY_KIND_LABELS, type EntityNode, type UserNodeData } from '../types'
import { NodeTag } from './NodeTag'
import { entityInformationIds, nodeLabel } from '../lib/nodeActions'
import { PreviousNodeButton } from './PreviousNodeButton'
import { NodeActions } from './NodeActions'

export function EntityCard({ id, data, selected, display }: NodeProps<EntityNode> & { display?: UserNodeData }) {
  const session = useStore((s) => s.session)
  const navigate = useStore((s) => s.navigateTo)
  const replyTo = useStore((s) => s.replyTo)
  const stored = session?.contentGraph?.entities[data.entityId]
  const entity = display ? { name: display.title, subtype: display.entitySubtype ?? 'other', qualifier: display.qualifier, aliases: display.aliases ?? [] } : stored?.type === 'entity' ? stored : null
  if (!entity) return null
  const informationIds = entityInformationIds(session, id)
  const canExpand = Boolean(informationIds.length || entity.qualifier || entity.aliases.length)
  return <>
    <Handle type="target" position={Position.Left} />
    <article className={`entity-card ${selected ? 'is-selected' : ''} ${replyTo === id ? 'is-reply-target' : ''}`} aria-label={`엔티티 · ${entity.name}`}>
      <header><NodeTag kind="entity" /><small className="entity-type" title={display ? '사용자 편집' : undefined}>{display?.label ?? ENTITY_KIND_LABELS[entity.subtype] ?? '기타'}</small>
        <NodeActions id={id} collapsed={data.collapsed} canCollapse={canExpand} /></header>
      <EditableNodeContent id={id}>
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
      </EditableNodeContent>
    </article>
    <Handle type="source" position={Position.Right} />
  </>
}
