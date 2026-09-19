import { useEffect, useReducer } from 'react'
import type { Session } from '../types'
import { elapsedResponseTime } from '../lib/responseTiming'

export function ResponseTimer({ timings }: { timings: Session['responseTimings'] }) {
  const latest = Object.entries(timings ?? {}).sort((a, b) => b[1].startedAt - a[1].startedAt)[0]
  const [, tick] = useReducer((value: number) => value + 1, 0)
  const running = latest?.[1].status === 'running'
  useEffect(() => {
    if (!running) return
    const timer = setInterval(tick, 100)
    return () => clearInterval(timer)
  }, [running])
  if (!latest) return null
  const [id, timing] = latest
  const label = { running: '생성 중', completed: '응답 시간', failed: '생성 실패', cancelled: '중지', interrupted: '시간 기록 중단' }[timing.status]
  return <span className="response-timer" aria-label="응답 및 노드 생성 시간" title="최근 요청 전송부터 응답·출처 처리·하위 노드 생성까지의 시간">
    {label}{timing.status !== 'interrupted' && ` ${(elapsedResponseTime(id, timing) / 1000).toFixed(1)}초`}
  </span>
}
