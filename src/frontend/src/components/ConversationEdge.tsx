import { InlineEdgeEditor } from './CanvasEditor'
import { useEdgeArrival } from '../hooks/useEdgeArrival'
import { ArrivingEdgePath } from './ArrivingEdgePath'
import { getBezierPath, type EdgeProps } from '@xyflow/react'

// Conversation order is navigation, not a claim about evidence or semantic relations.
export function ConversationEdge(props: EdgeProps) {
  const arrival = useEdgeArrival(props.data)
  const [path, x, y] = getBezierPath(props)
  return <><ArrivingEdgePath {...props} path={path} arrivalDelay={arrival.delay} onArrivalEnd={arrival.finish} /><InlineEdgeEditor id={props.id} x={x} y={y} /></>
}
