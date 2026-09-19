import type { ResponseTiming, Session } from '../types'

const clocks = new Map<string, number>()

export function startResponseTiming(requestId: string): ResponseTiming {
  clocks.set(requestId, performance.now())
  return { startedAt: Date.now(), status: 'running' }
}

export function elapsedResponseTime(requestId: string, timing: ResponseTiming): number {
  if (timing.status !== 'running') return timing.durationMs ?? 0
  const start = clocks.get(requestId)
  return Math.max(0, start === undefined ? Date.now() - timing.startedAt : performance.now() - start)
}

export function finishResponseTiming(session: Session, requestId: string | null | undefined, status: Exclude<ResponseTiming['status'], 'running'>): Session {
  const timing = requestId ? session.responseTimings?.[requestId] : undefined
  if (!requestId || !timing || timing.status !== 'running') return session
  const durationMs = status === 'interrupted' ? undefined : Math.round(elapsedResponseTime(requestId, timing))
  clocks.delete(requestId)
  return { ...session, responseTimings: { ...session.responseTimings, [requestId]: { ...timing, status, durationMs } } }
}

export function finishResponseStructure(session: Session, responseId: string, status: 'completed' | 'failed' | 'cancelled'): Session {
  const requestId = Object.keys(session.responseTimings ?? {}).find((key) => {
    const timing = session.responseTimings![key]
    return timing.responseId === responseId && timing.status === 'running'
  })
  return finishResponseTiming(session, requestId, status)
}
