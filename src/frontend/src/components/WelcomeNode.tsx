import {
  BaseEdge,
  Handle,
  Position,
  getBezierPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import { Copy, MessageCirclePlus } from 'lucide-react'
import { RabbitIcon } from './RabbitIcon'
import { useStore } from '../store'

// Presentation-only nodes: never stored in sessions or sent as response context.
export type WelcomeCanvasNode = Node<
  | { kind: 'brand' }
  | { kind: 'question'; prompt: string; above: boolean; tone: number; usePrompt: (prompt: string) => void },
  'welcome'
>

export function WelcomeNode({ data }: NodeProps<WelcomeCanvasNode>) {
  if (data.kind === 'brand')
    return (
      <section className="welcome-canvas-brand" aria-label="Rabbit Hole 시작 노드">
        <div className="welcome-side-note welcome-side-note-left" aria-hidden="true">
          <p>작은 궁금함도<br />좋아요</p>
          <svg viewBox="0 0 90 46" fill="none">
            <path d="M5 7C19 34 50 39 81 22M69 20L83 21L77 34" />
          </svg>
        </div>
        <div className="welcome-side-note welcome-side-note-right" aria-hidden="true">
          <p>답을 따라,<br />다음 생각으로</p>
          <svg viewBox="0 0 110 30" fill="none">
            <path d="M6 18C30 8 56 8 78 13M86 8L92 2M89 18L103 17M86 25L95 29" />
          </svg>
        </div>
        <div className="welcome-brand">
          <RabbitIcon />
          <span>Rabbit Hole</span>
        </div>
        <h1>호기심이 이어지는 곳</h1>
        <p className="welcome-handwritten">
          여기서, <span>호기심을 이어 보세요
            <svg viewBox="0 0 210 12" fill="none" aria-hidden="true">
              <path d="M3 7C49 2 135 2 205 6M18 10C78 6 143 7 185 9" />
            </svg>
          </span>
        </p>
        <Handle id="above" type="source" position={Position.Top} className="welcome-handle" />
        <Handle id="below" type="source" position={Position.Bottom} className="welcome-handle" />
      </section>
    )

  async function copy() {
    try {
      await navigator.clipboard.writeText(data.kind === 'question' ? data.prompt : '')
      useStore.setState({ actionNotice: { id: crypto.randomUUID(), message: '복사를 완료했습니다' } })
    } catch {
      useStore.setState({ error: '예시 질문을 복사하지 못했습니다. 다시 시도해 주세요.' })
    }
  }
  return (
    <article className={`welcome-question tone-${data.tone}`} aria-label={`예시 질문 · ${data.prompt}`}>
      <Handle
        type="target"
        position={data.above ? Position.Bottom : Position.Top}
        className="welcome-handle"
      />
      <p>{data.prompt}</p>
      <div className="welcome-question-actions nodrag nopan">
        <button type="button" aria-label="복사하기" data-tooltip="복사하기" onClick={() => void copy()}>
          <Copy size={16} />
        </button>
        <button
          type="button"
          aria-label="다음 응답에 활용"
          data-tooltip="다음 응답에 활용"
          onClick={() => data.usePrompt(data.prompt)}
        >
          <MessageCirclePlus size={17} />
        </button>
      </div>
    </article>
  )
}

export function WelcomeExampleEdge(props: EdgeProps) {
  const [path] = getBezierPath(props)
  return <BaseEdge path={path} style={props.style} interactionWidth={0} />
}

export function welcomeGraph(
  width: number,
  usePrompt: (prompt: string) => void,
): { nodes: WelcomeCanvasNode[]; edges: Edge[] } {
  const mobile = width <= 700
  const cardWidth = mobile ? Math.min(320, width - 48) : 310
  const common = {
    type: 'welcome' as const,
    draggable: false,
    selectable: false,
    connectable: false,
    focusable: false,
  }
  const prompts = [
    '아이폰 폴더블, 언제 나오고 무엇이 달라질까요? 공개된 정보와 전망을 나눠 알려주세요.',
    'gpt-6-astra는 어떤 모델인가요? 주요 특징과 잘 맞는 활용 사례를 알려주세요.',
    '원티드 AI Championship 2026에 참가하고 싶어요. 일정, 참가 조건, 주제를 정리해 주세요.',
    'https://github.com/rabbitholechat/rabbit-hole 해당 링크에서제공하는 오픈소스 프로젝트를 활용해보고 싶어요. 설치와 실행 방법을 알려주세요.',
  ]
  const positions = mobile
    ? [
        { x: -cardWidth / 2, y: -350 },
        { x: cardWidth / 2 + 42, y: -386 },
        { x: -cardWidth / 2 - 16, y: 100 },
        { x: cardWidth / 2 + 62, y: 162 },
      ]
    : [
        { x: -410, y: -352 },
        { x: 84, y: -380 },
        { x: -382, y: 100 },
        { x: 116, y: 158 },
      ]
  const nodes: WelcomeCanvasNode[] = [
    { ...common, id: 'welcome-brand', position: { x: -160, y: -180 }, width: 320, data: { kind: 'brand' } },
    ...prompts.map((prompt, index): WelcomeCanvasNode => ({
      ...common,
      id: `welcome-question-${index}`,
      width: cardWidth,
      position: positions[index],
      data: { kind: 'question', prompt, above: index < 2, tone: index, usePrompt },
    })),
  ]
  const edges: Edge[] = prompts.map((_, index) => ({
    id: `welcome-example-${index}`,
    source: 'welcome-brand',
    sourceHandle: index < 2 ? 'above' : 'below',
    target: `welcome-question-${index}`,
    type: 'welcomeExample',
    selectable: false,
    focusable: false,
    reconnectable: false,
    ariaLabel: '시작 노드에서 이어진 예시 질문',
    style: { stroke: '#95b4a3', strokeWidth: 1.5, strokeDasharray: '5 5' },
  }))
  return { nodes, edges }
}
