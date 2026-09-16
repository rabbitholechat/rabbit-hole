import type { Envelope } from '../types'
export async function consumeSSE(
  response: Response,
  receive: (event: Envelope) => void,
  signal: AbortSignal,
) {
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new Error(
      typeof error?.detail === 'string'
        ? error.detail
        : '요청을 처리하지 못했습니다. 입력 조건을 확인하세요.',
    )
  }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream'))
    throw new Error('검색 스트림을 열지 못했습니다.')
  const reader = response.body.getReader(),
    decoder = new TextDecoder()
  let buffer = ''
  let finished = false
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n')
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data) {
          const event = JSON.parse(data) as Envelope
          if (event.version !== 1) throw new Error('지원하지 않는 응답 버전입니다.')
          if (signal.aborted) return
          receive(event)
          if (event.type === 'done') finished = true
        }
      }
      if (done) break
    }
    if (!finished && !signal.aborted) throw new Error('연결이 종료되었습니다. 받은 결과는 보존했습니다.')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
