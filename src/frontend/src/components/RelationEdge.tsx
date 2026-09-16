import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'
import { useStore } from '../store'
export function RelationEdge(props: EdgeProps) {
  const [path, x, y] = getBezierPath(props)
  return <><BaseEdge id={props.id} path={path} style={props.style}/><EdgeLabelRenderer>
    <button className="edge-label nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
      onClick={() => useStore.getState().selectEdge(Number(props.id.slice(5)))} aria-label={`관계: ${props.label}`}>{props.label}</button>
  </EdgeLabelRenderer></>
}
