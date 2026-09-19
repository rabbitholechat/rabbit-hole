import { MessageSquareText, Lightbulb, Globe2, Image, Diamond } from 'lucide-react'

const nodeKinds = {
  response: { label: '응답', Icon: MessageSquareText },
  information: { label: '정보', Icon: Lightbulb },
  entity: { label: '엔티티', Icon: Diamond },
  image: { label: '이미지', Icon: Image },
  source: { label: '출처', Icon: Globe2, Image },
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
