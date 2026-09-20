import type { Session, ShareCreated, SharedCanvas } from '../types'

async function request<T>(path: string, session?: Session, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/shares${path}`, {
    method: session ? 'POST' : 'GET',
    cache: 'no-store',
    headers: session ? { 'Content-Type': 'application/json' } : undefined,
    body: session ? JSON.stringify(session) : undefined,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
  })
  if (!response.ok)
    throw Error(
      response.status === 404
        ? '공유 캔버스를 찾을 수 없습니다.'
        : response.status === 413
          ? '캔버스가 공유 용량 제한을 초과했습니다.'
          : '공유 캔버스를 불러오거나 저장하지 못했습니다. 다시 시도해 주세요.',
    )
  return response.json()
}
export const shareApi = {
  create: (session: Session) => request<ShareCreated>('', session),
  get: (id: string, signal?: AbortSignal) =>
    request<SharedCanvas>(`/${encodeURIComponent(id)}`, undefined, signal),
}
