import { InlineEdgeEditor } from './CanvasEditor'
import { EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'
import { useEdgeArrival } from '../hooks/useEdgeArrival'
import { ArrivingEdgePath } from './ArrivingEdgePath'
import { useStore } from '../store'
export function RelationEdge(props: EdgeProps) {
  const editing = useStore(s => s.editingEdge === props.id)
  const arrival = useEdgeArrival(props.data)
  const [path, x, y] = getBezierPath(props)
  return (
    <>
      <ArrivingEdgePath {...props} path={path} arrivalDelay={arrival.delay} onArrivalEnd={arrival.finish} />
      <InlineEdgeEditor id={props.id} x={x} y={y} />
      {!editing && <EdgeLabelRenderer>
        <button
          className="edge-label nodrag nopan"
          style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
          onClick={() => useStore.getState().selectEdge(Number(props.id.slice(5)))}
          aria-label={`관계: ${props.label}`}
        >
          {props.label}
        </button>
      </EdgeLabelRenderer>}
    </>
  )
}
