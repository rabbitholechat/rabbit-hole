import type { HistoryList, HistoryWrite, ImportResult, Revision, Session } from '../types'

async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/sessions${path}`, {
    method,
    cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
  })
  if (!response.ok) {
    if (response.status === 409)
      throw Error('다른 화면에서 기록이 변경되거나 삭제되었습니다. 현재 내용을 복사한 뒤 새로고침해 주세요.')
    if (response.status === 413)
      throw Error('기록이 서버 저장 용량 제한을 초과했습니다. 현재 내용을 복사해 보관해 주세요.')
    throw Error('서버 기록 저장소에 연결할 수 없습니다. 현재 화면의 내용은 유지됩니다.')
  }
  return response.status === 204 ? undefined as T : response.json()
}

export const historyApi = {
  list: (cursor?: string) => request<HistoryList>(cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''),
  get: (id: string, signal?: AbortSignal) => request<HistoryWrite>(`/${encodeURIComponent(id)}`, 'GET', undefined, signal),
  save: (id: string, body: HistoryWrite) => request<Revision>(`/${encodeURIComponent(id)}`, 'PUT', body),
  import: (session: Session) => request<ImportResult>(`/${encodeURIComponent(session.id)}/import`, 'POST', session),
  delete: (id: string, revision: number) => request<void>(`/${encodeURIComponent(id)}?revision=${revision}`, 'DELETE'),
}
