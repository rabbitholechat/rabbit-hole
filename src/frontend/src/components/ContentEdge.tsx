import type { CSSProperties } from 'react'
import { useEdgeArrival } from '../hooks/useEdgeArrival'
import { ArrivingEdgePath } from './ArrivingEdgePath'
import { EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'

export function ContentEdge(props: EdgeProps) {
  const arrival = useEdgeArrival(props.data)
  const [path, x, y] = getBezierPath(props)
  return (
    <>
      <ArrivingEdgePath {...props} path={path} arrivalDelay={arrival.delay} onArrivalEnd={arrival.finish} />
      <EdgeLabelRenderer>
        <span
          className={`content-edge-label ${arrival.delay !== null ? 'connection-label-arriving' : ''}`}
          style={{ '--edge-color': props.style?.stroke, transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`, '--arrival-delay': `${(arrival.delay ?? 0) + 400}ms` } as CSSProperties}
        >
          {props.label}
        </span>
      </EdgeLabelRenderer>
    </>
  )
}
