import { RotateCcw } from 'lucide-react'
import { RabbitIcon } from './RabbitIcon'
import { Button } from './ui/button'

export function ServerErrorPage({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  return (
    <section className="server-error-page" aria-labelledby="server-error-title">
      <div className="server-error-content">
        <div className="server-error-brand" aria-label="Rabbit Hole">
          <RabbitIcon />
          <span>Rabbit Hole</span>
        </div>
        <h1 id="server-error-title">서버에 오류가 발생했어요</h1>
        <Button onClick={onRetry} disabled={retrying}>
          <RotateCcw aria-hidden="true" />
          {retrying ? '다시 연결하고 있어요' : '다시 시도'}
        </Button>
        <span className="sr-only" role="status">
          {retrying ? '서버에 다시 연결하고 있습니다.' : '서버 오류가 발생했습니다.'}
        </span>
      </div>
    </section>
  )
}
