import { useEffect, useState, type ReactNode } from 'react'
import { shareApi } from '../lib/shareApi'
import { useStore } from '../store'
import { HistoryLoading } from './HistoryLoading'

export function SharedCanvasPage({ id, children }: { id: string; children: ReactNode }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    setStatus('loading')
    void shareApi
      .get(id, abort.signal)
      .then(({ session }) => {
        if (abort.signal.aborted) return
        useStore.setState({
          session: { ...session, readOnly: true, fitted: true },
          history: [],
          retryingServer: false,
          serverError: false,
          loadingSessionId: null,
          selected: null,
          selectedLink: null,
          undoStack: [],
          redoStack: [],
        })
        setStatus('ready')
      })
      .catch((error) => {
        if (!abort.signal.aborted) {
          setMessage(error instanceof Error ? error.message : '공유 캔버스를 불러오지 못했습니다.')
          setStatus('error')
        }
      })
    return () => abort.abort()
  }, [id, attempt])
  if (status === 'loading')
    return (
      <main className="workspace">
        <HistoryLoading canvas />
      </main>
    )
  if (status === 'error')
    return (
      <main className="share-error panel">
        <h1>공유 캔버스</h1>
        <p role="alert">{message}</p>
        <button onClick={() => setAttempt(attempt + 1)}>다시 시도</button>
        <a href="/">새 대화 열기</a>
      </main>
    )
  return children
}
