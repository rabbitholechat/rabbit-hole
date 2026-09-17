import { MessageSquareText, Lightbulb, Globe2 } from 'lucide-react'

const nodeKinds = {
  response: { label: '응답', Icon: MessageSquareText },
  information: { label: '정보', Icon: Lightbulb },
  source: { label: '출처', Icon: Globe2 },
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
