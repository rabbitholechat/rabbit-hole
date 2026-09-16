import { describe, expect, it } from 'vitest'
import { consumeSSE } from '../src/lib/sse'
function response(parts: string[]) {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({ start(controller) { for (const p of parts) controller.enqueue(encoder.encode(p)); controller.close() } }), { headers: { 'Content-Type': 'text/event-stream' } })
}
describe('SSE parser', () => {
  it('handles chunk boundaries, unicode, comments and final state', async () => {
    const seen: unknown[] = []
    await consumeSSE(response([': ping\n\ndata: {"version":1,"ty', 'pe":"status","data":{"stage":"검색"}}\n\n', 'data: {"version":1,"type":"done"}\n\n']), e => seen.push(e), new AbortController().signal)
    expect(seen).toHaveLength(2)
  })
  it('reports truncated streams rather than silently completing', async () => {
    await expect(consumeSSE(response(['data: {"version":1,"type":"sources"}\n\n']), () => {}, new AbortController().signal)).rejects.toThrow('연결이 종료')
  })
})
