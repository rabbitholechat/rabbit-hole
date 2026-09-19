import { useStore } from '../store'
import { InlineEdgeEditor } from './CanvasEditor'
import type { CSSProperties } from 'react'
import { useEdgeArrival } from '../hooks/useEdgeArrival'
import { ArrivingEdgePath } from './ArrivingEdgePath'
import { EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'

export function ContentEdge(props: EdgeProps) {
  const editing = useStore(s => s.editingEdge === props.id)
  const arrival = useEdgeArrival(props.data)
  const [path, x, y] = getBezierPath(props)
  return (
    <>
      <ArrivingEdgePath {...props} path={path} arrivalDelay={arrival.delay} onArrivalEnd={arrival.finish} />
      <InlineEdgeEditor id={props.id} x={x} y={y} />
      {!editing && <EdgeLabelRenderer>
        <button type="button" aria-label={`수정하기: ${props.label}`} title="수정하기" onClick={() => useStore.getState().editEdge(props.id)}
          className={`content-edge-label nodrag nopan ${arrival.delay !== null ? 'connection-label-arriving' : ''}`}
          style={{ '--edge-color': props.style?.stroke, transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`, '--arrival-delay': `${(arrival.delay ?? 0) + 400}ms` } as CSSProperties}
        >
          {props.label}
        </button>
      </EdgeLabelRenderer>}
    </>
  )
}
