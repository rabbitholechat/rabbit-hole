import { ArrivingEdgePath } from './ArrivingEdgePath'
import { getBezierPath, type EdgeProps } from '@xyflow/react'

// Conversation order is navigation, not a claim about evidence or semantic relations.
export function ConversationEdge(props: EdgeProps) {
  const [path] = getBezierPath(props)
  return <ArrivingEdgePath {...props} path={path} />
}
