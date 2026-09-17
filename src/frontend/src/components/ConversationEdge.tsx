import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react'

// Conversation order is navigation, not a claim about evidence or semantic relations.
export function ConversationEdge(props: EdgeProps) {
  const [path] = getBezierPath(props)
  return <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} style={props.style} />
}
