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
        <p className="server-error-code">500 · SERVER ERROR</p>
        <h1 id="server-error-title">서버에 오류가 발생했어요</h1>
        <p className="server-error-description">잠시 후 다시 시도해 주세요.</p>
        <Button variant="outline" onClick={onRetry} disabled={retrying}>
          <RotateCcw aria-hidden="true" />
          {retrying ? '다시 연결하고 있어요' : '다시 시도'}
        </Button>
        <span className="sr-only" role="status">{retrying ? '서버에 다시 연결하고 있습니다.' : '서버 오류가 발생했습니다.'}</span>
      </div>
    </section>
  )
}
