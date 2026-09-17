import { RabbitLoader } from './RabbitLoader'

export function HistoryLoading({ canvas = false }: { canvas?: boolean }) {
  return (
    <div className={canvas ? 'canvas-loading' : 'history-loading'} role="status" aria-live="polite">
      <RabbitLoader />
      <span>{canvas ? '대화를 불러오고 있어요' : '대화 목록을 불러오고 있어요'}</span>
    </div>
  )
}
