import { Button } from './ui/button'
import type { Clarification } from '../types'
import { useStore } from '../store'

export function ClarificationPanel({ clarification }: { clarification: Clarification }) {
  const setInput = useStore((s) => s.setInput)
  return (
    <section className="clarification-panel panel" aria-label="추가 질문">
      <h2>{clarification.message}</h2>
      <ul>
        {clarification.questions.map((question, index) => (
          <li key={index}>{question}</li>
        ))}
      </ul>
      {clarification.suggestions.length > 0 && (
        <div className="clarification-suggestions" aria-label="답변 예시">
          {clarification.suggestions.map((suggestion, index) => (
            <Button
              key={index}
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setInput(suggestion)}
            >
              {suggestion}
            </Button>
          ))}
        </div>
      )}
      <p>아래 입력창에 답변해 주세요. 답변 예시는 선택해 수정할 수 있습니다.</p>
    </section>
  )
}
