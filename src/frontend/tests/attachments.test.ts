import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('../src/lib/historyApi', async () => {
  const { memoryHistoryApi } = await import('./fixtures/historyApi')
  return { historyApi: memoryHistoryApi() }
})
import { useStore } from '../src/store'
import { appendResponse, parseAttachment } from '../src/lib/attachments'
import type { Attachment, Session } from '../src/types'

const attachment: Attachment = {
  id: '11111111-1111-4111-8111-111111111111', name: 'note.txt', kind: 'file', media_type: 'text/plain', size: 4,
  download_url: '/api/attachments/11111111-1111-4111-8111-111111111111/content', preview_url: null,
  text_excerpt: 'note', width: null, height: null, pages: null,
}
const limits = {max_bytes: 3000000, max_count: 4, max_text_chars: 32000, max_pdf_pages: 20}
beforeEach(() => { useStore.getState().newConversation(); vi.restoreAllMocks() })

it('renders attachment sources above the response before the agent request and reuses them on retry', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (url === '/api/attachments/limits') return Response.json(limits)
    if (String(url).startsWith('/api/attachments?')) return Response.json(attachment, {status: 201})
    if (url === '/api/agent') {
      const state = useStore.getState(), nodes = state.session!.nodes
      expect(nodes.filter(n => n.type === 'attachment')).toHaveLength(1)
      expect(nodes.filter(n => n.type === 'response').at(-1)!.data.status).toBe('streaming')
      expect(nodes.find(n => n.type === 'attachment')!.position.y + 260).toBeLessThan(nodes.filter(n => n.type === 'response').at(-1)!.position.y)
      expect(JSON.parse(init!.body as string).attachment_ids).toEqual([attachment.id])
      return new Response('{}', {status: 503})
    }
    throw Error('Unexpected network request')
  })
  await useStore.getState().addAttachments([new File(['note'], 'note.txt')])
  expect(useStore.getState().draftAttachments[0].status).toBe('ready')
  await useStore.getState().run()
  expect(useStore.getState().draftAttachments).toEqual([])
  expect(useStore.getState().session!.nodes.find(n => n.type === 'response')!.data.prompt).toBe('첨부한 자료를 설명해 주세요.')
  const sourcePosition = useStore.getState().session!.nodes.find(n => n.type === 'attachment')!.position
  await useStore.getState().run({retry: true})
  expect(useStore.getState().session!.nodes.find(n => n.type === 'attachment')!.position).toEqual(sourcePosition)
  expect(fetcher.mock.calls.filter(([url]) => String(url).startsWith('/api/attachments?'))).toHaveLength(1)
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/agent')).toHaveLength(2)
})

it('failed and pending uploads cannot be sent and cancellation ignores a late completion', async () => {
  let finish!: () => void
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (url === '/api/attachments/limits') return Response.json(limits)
    if (String(url).startsWith('/api/attachments?')) return new Promise(resolve => {finish = () => resolve(Response.json(attachment))})
    return new Response(null, {status: 204})
  })
  const pending = useStore.getState().addAttachments([new File(['note'], 'note.txt')])
  await vi.waitFor(() => expect(finish).toBeDefined())
  useStore.getState().setInput('질문')
  await useStore.getState().run()
  expect(fetcher.mock.calls.some(([url]) => url === '/api/agent')).toBe(false)
  useStore.getState().clearAttachments()
  finish()
  await pending
  expect(useStore.getState().draftAttachments).toEqual([])
  expect(fetcher.mock.calls.some(([url, init]) => String(url).endsWith(attachment.id) && init?.method === 'DELETE')).toBe(true)
})

it('rejects external preview URLs and keeps older nodes and viewport fixed when adding input sources', () => {
  expect(() => parseAttachment({...attachment, preview_url: 'https://untrusted.example/image'})).toThrow()
  const session = {nodes: [{id:'old', type:'response', width:560, position:{x:0,y:0}, data:{prompt:'q',text:'a',status:'completed'}}],
    viewport:{x:88,y:99,zoom:.8}, responseTimings:{}, lastRequestedTool:undefined} as unknown as Session
  const result = appendResponse(session, 'new', 'request', 'old', '질문', [attachment])
  expect(result.nodes[0]).toEqual(session.nodes[0])
  expect(result.viewport).toEqual(session.viewport)
  const response = result.nodes.at(-1)!
  expect(response.type === 'response' && response.data.attachments).toEqual([attachment])
})


it('reuses original attachment IDs without upload and never deletes saved inputs when removed', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch')
  useStore.getState().reuseAttachment(attachment)
  useStore.getState().reuseAttachment(attachment)
  expect(useStore.getState().draftAttachments).toHaveLength(1)
  expect(useStore.getState().draftAttachments[0]).toMatchObject({status:'ready', attachment, reused:true})
  useStore.getState().clearAttachments()
  expect(fetcher).not.toHaveBeenCalled()
})
