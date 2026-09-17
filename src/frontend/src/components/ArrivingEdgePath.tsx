import { useId, type CSSProperties } from 'react'
import { BaseEdge, type EdgeProps } from '@xyflow/react'

export function ArrivingEdgePath({ path, arrivalDelay, onArrivalEnd, ...props }: EdgeProps & { path: string; arrivalDelay: number | null; onArrivalEnd: () => void }) {
  const maskId = `arrival-${useId().replace(/:/g, '')}`
  const delay = arrivalDelay
  const edge = <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} style={props.style} />
  if (delay === null) return edge
  return (
    <>
      <defs>
        <mask
          id={maskId}
          maskUnits="userSpaceOnUse"
          x={Math.min(props.sourceX, props.targetX) - 240}
          y={Math.min(props.sourceY, props.targetY) - 240}
          width={Math.abs(props.targetX - props.sourceX) + 480}
          height={Math.abs(props.targetY - props.sourceY) + 480}
        >
          <path
            className="connection-reveal is-arriving"
            onAnimationEnd={(event) => { if (event.animationName === 'edge-arrive') onArrivalEnd() }}
            style={{ '--arrival-delay': `${delay}ms` } as CSSProperties}
            d={path}
            pathLength={1}
            fill="none"
            stroke="white"
            strokeWidth={48}
            strokeLinecap="round"
          />
        </mask>
      </defs>
      <g mask={`url(#${maskId})`}>{edge}</g>
    </>
  )
}
