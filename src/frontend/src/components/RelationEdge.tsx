import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'
import { useId } from 'react'
import { useStore } from '../store'
export function RelationEdge(props: EdgeProps) {
  const revealId = `edge-reveal-${useId().replace(/:/g, '')}`
  const [path, x, y] = getBezierPath(props)
  return (
    <>
      <defs>
        <mask
          id={revealId}
          maskUnits="userSpaceOnUse"
          x={Math.min(props.sourceX, props.targetX) - 200}
          y={Math.min(props.sourceY, props.targetY) - 200}
          width={Math.abs(props.targetX - props.sourceX) + 400}
          height={Math.abs(props.targetY - props.sourceY) + 400}
        >
          <path
            className="edge-reveal"
            d={path}
            pathLength={1}
            fill="none"
            stroke="white"
            strokeWidth={32}
            strokeLinecap="round"
          />
        </mask>
      </defs>
      <g mask={`url(#${revealId})`}>
        <BaseEdge id={props.id} path={path} style={props.style} markerEnd={props.markerEnd} />
      </g>
      <EdgeLabelRenderer>
        <button
          className="edge-label nodrag nopan"
          style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
          onClick={() => useStore.getState().selectEdge(Number(props.id.slice(5)))}
          aria-label={`관계: ${props.label}`}
        >
          {props.label}
        </button>
      </EdgeLabelRenderer>
    </>
  )
}
