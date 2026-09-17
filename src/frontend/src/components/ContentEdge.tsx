import type { CSSProperties } from 'react'
import { ArrivingEdgePath } from './ArrivingEdgePath'
import { EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'

export function ContentEdge(props: EdgeProps) {
  const [path, x, y] = getBezierPath(props)
  return (
    <>
      <ArrivingEdgePath {...props} path={path} />
      <EdgeLabelRenderer>
        <span
          className={`content-edge-label ${typeof props.data?.arrivalDelay === 'number' ? 'connection-label-arriving' : ''}`}
          style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`, '--arrival-delay': `${Number(props.data?.arrivalDelay ?? 0) + 400}ms` } as CSSProperties}
        >
          {props.label}
        </span>
      </EdgeLabelRenderer>
    </>
  )
}
