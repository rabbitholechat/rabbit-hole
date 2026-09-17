import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'

export function ContentEdge(props: EdgeProps) {
  const [path, x, y] = getBezierPath(props)
  return (
    <>
      <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} style={props.style} />
      <EdgeLabelRenderer>
        <span
          className="content-edge-label"
          style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
        >
          {props.label}
        </span>
      </EdgeLabelRenderer>
    </>
  )
}
