import { MessageSquareText } from 'lucide-react'

const nodeKinds = {
  response: { label: '응답', Icon: MessageSquareText },
} as const

export function NodeTag({ kind }: { kind: keyof typeof nodeKinds }) {
  const { label, Icon } = nodeKinds[kind]
  return (
    <span className="node-tag">
      <Icon size={18} aria-hidden="true" />
      {label}
    </span>
  )
}
