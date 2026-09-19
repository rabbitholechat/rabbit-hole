import { nodeContext } from './lib/nodeActions'
import { create } from 'zustand'
import { applyNodeChanges, type NodeChange, type Viewport } from '@xyflow/react'
import type { CanvasNode, Envelope, Session, ResponseNode, RequestedTool, AgentRequest } from './types'
import { deleteSession, loadSession, loadSessions, saveSession } from './lib/db'
import { consumeSSE } from './lib/sse'
import { parseToolSources } from './lib/toolSources'
import { startResponseTiming, finishResponseTiming, finishResponseStructure } from './lib/responseTiming'
import {
  attachInformation,
  attachSources,
  emptyContentGraph,
  hashText,
  responseById,
  validateStructure,
} from './lib/contentGraph'

const emptySession = (query: string): Session => ({
  id: crypto.randomUUID(),
  query,
  updatedAt: Date.now(),
  mode: 'live',
  protocol: 2,
  sources: [],
  nodes: [],
  graph: { relations: [], clusters: [] },
  answer: null,
  viewport: { x: 0, y: 0, zoom: 1 },
  fitted: false,
  pinned: [],
  status: 'idle',
  failedParts: [],
})
let controller: AbortController | undefined
let access: { id: string; token: string } | undefined
let persistence: Promise<unknown> = Promise.resolve()
let historyController: AbortController | undefined
let initialization: Promise<void> | undefined
let saveTimer: ReturnType<typeof setTimeout> | undefined
const structureRequests = new Map<string, AbortController>()
function persist(session: Session) {
  const snapshot = structuredClone(session)
  persistence = persistence
    .catch(() => {})
    .then(() => saveSession(snapshot))
    .catch((error: unknown) => {
      useStore.setState({ storageError: error instanceof Error ? error.message : '서버에 기록을 저장하지 못했습니다.' })
    })
}
interface State {
  session: Session | null
  history: Session[]
  loadingSessionId: string | null
  failedSessionId: string | null
  input: string
  requestedTool: RequestedTool | null
  setRequestedTool: (tool: RequestedTool | null) => void
  selected: string | null
  selectedEdge: number | null
  activeRequest: string | null
  responseId: string | null
  replyTo: string | null
  pendingParentId: string | null
  reply: (id: string | null) => void
  toggleResponse: (id: string) => void
  toggleNode: (id: string) => void
  pendingQuery: string
  lastSeq: number
  stage: string
  error: string | null
  storageError: string | null
  serverError: boolean
  retryingServer: boolean
  initialize: () => Promise<void>
  setInput: (input: string) => void
  newConversation: () => void
  open: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  structure: (responseId: string) => Promise<void>
  cancelStructure: (responseId: string) => void
  navigation: { id: string } | null
  navigateTo: (id: string) => void
  select: (id: string | null) => void
  selectEdge: (index: number | null) => void
  run: (options?: { retry?: boolean }) => Promise<void>
  stop: () => void
  receive: (event: Envelope) => void
  nodesChange: (changes: NodeChange<CanvasNode>[]) => void
  viewport: (viewport: Viewport) => void
  markFitted: () => void
}
function commit(session: Session) {
  useStore.setState((state) => ({
    session,
    history: [session, ...state.history.filter((s) => s.id !== session.id)].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    ),
  }))
  persist(session)
}
function updateSession(id: string, change: (session: Session) => Session) {
  const state = useStore.getState()
  const current = state.session?.id === id ? state.session : state.history.find((s) => s.id === id)
  if (!current) return
  const next = change(current)
  useStore.setState({
    ...(state.session?.id === id ? { session: next } : {}),
    history: state.history.map((s) => (s.id === id ? next : s)),
  })
  persist(next)
}
function cancelSessionStructures() {
  const session = useStore.getState().session
  if (!session) return
  for (const [id, job] of Object.entries(session.contentGraph?.jobs ?? {})) {
    if (job.status === 'running') useStore.getState().cancelStructure(id)
  }
}
// Independent request: title work never holds the response stream or changes the viewport.
async function generateTitle(session: Session) {
  if (session.titleRequested || !session.continuation || session.mode !== 'live') return
  if (session.nodes.filter((n) => n.type === 'response' && n.data.status === 'completed').length !== 1) return
  commit({ ...session, titleRequested: true })
  try {
    const response = await fetch('/api/title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: crypto.randomUUID(), continuation: session.continuation }),
      signal: AbortSignal.timeout(20000),
    })
    if (!response.ok) return
    const data: unknown = await response.json()
    if (!data || typeof data !== 'object' || !('title' in data) || typeof data.title !== 'string') return
    const title = data.title.trim()
    if (!title || title.length > 60) return
    const state = useStore.getState()
    const current =
      state.session?.id === session.id ? state.session : state.history.find((item) => item.id === session.id)
    if (!current) return // Deleted conversations must not be resurrected.
    const updated = { ...current, title }
    useStore.setState({
      ...(state.session?.id === session.id ? { session: updated } : {}),
      history: state.history.map((item) => (item.id === session.id ? updated : item)),
    })
    persist(updated)
  } catch {
    // Keep the original query as the title; response completion is independent.
  }
}
function finish(session: Session, status: Session['status']): Session {
  const stopSource = (source: import('./types').ToolSource) => {
    const content = source.content
    if (!content || !['reading', 'summarizing'].includes(content.status)) return source
    return { ...source, content: { ...content, status: 'cancelled' as const } }
  }
  session = {
    ...session,
    nodes: session.nodes.map((node) => node.type === 'response'
      ? { ...node, data: { ...node.data, toolSources: node.data.toolSources?.map(stopSource) } } : node),
    ...(session.contentGraph ? { contentGraph: {
      ...session.contentGraph,
      entities: Object.fromEntries(Object.entries(session.contentGraph.entities).map(([id, entity]) =>
        [id, entity.type === 'source' ? { ...entity, source: stopSource(entity.source) } : entity])),
    } } : {}),
  }
  return {
    ...session,
    status,
    nodes: session.nodes.map((node) =>
      node.type === 'response' && node.data.status === 'streaming'
        ? {
            ...node,
            data: {
              ...node.data,
              status:
                status === 'completed'
                  ? 'completed'
                  : status === 'cancelled'
                    ? 'cancelled'
                    : node.data.text
                      ? 'partial'
                      : 'failed',
            },
          }
        : node,
    ),
  }
}
function restoreSession(session: Session): Session {
  for (const requestId of Object.keys(session.responseTimings ?? {}))
    session = finishResponseTiming(session, requestId, 'interrupted')
  let restored: Session = {
    ...session,
    nodes: session.nodes.map((node) => {
      const { height: _height, measured: _measured, ...rest } = node
      if (node.type === 'source')
        return { ...rest, type: 'source', data: { ...node.data, collapsed: node.data.collapsed ?? true }, width: Math.max(node.width ?? 0, 460) } as CanvasNode
      if (node.type === 'entity') return { ...rest, width: Math.max(node.width ?? 0, 340) }
      return rest
    }),
  }
  if (restored.status === 'running') restored = finish(restored, 'partial')
  if (restored.contentGraph)
    restored = { ...restored, contentGraph: { ...restored.contentGraph,
      jobs: Object.fromEntries(Object.entries(restored.contentGraph.jobs).map(([id, job]) => [
        id, job.status === 'running' ? { ...job, status: 'cancelled' as const } : job,
      ])),
    } }
  if (restored.protocol === 2)
    for (const node of restored.nodes)
      if (node.type === 'response') restored = attachSources(restored, node.id)
  return restored
}

export const useStore = create<State>((set, get) => ({
  session: null,
  history: [],
  loadingSessionId: null,
  failedSessionId: null,
  input: '',
  navigation: null,
  navigateTo: (id) => set({ navigation: { id }, selected: id, selectedEdge: null }),
  selected: null,
  selectedEdge: null,
  activeRequest: null,
  responseId: null,
  replyTo: null,
  pendingParentId: null,
  pendingQuery: '',
  lastSeq: 0,
  stage: '',
  error: null,
  storageError: null,
  serverError: false,
  retryingServer: true,
  cancelStructure: (responseId) => {
    const session = get().session
    if (!session) return
    structureRequests.get(`${session.id}:${responseId}`)?.abort()
    updateSession(session.id, (current) => {
      const graph = current.contentGraph
      const job = graph?.jobs[responseId]
      if (!graph || !job || job.status !== 'running') return current
      return {
        ...finishResponseStructure(current, responseId, 'cancelled'),
        contentGraph: { ...graph, jobs: { ...graph.jobs, [responseId]: { ...job, status: 'cancelled' } } },
      }
    })
  },
  structure: async (responseId) => {
    const session = get().session
    if (!session || session.protocol !== 2 || session.mode !== 'live') return
    const response = responseById(session, responseId)
    if (!response || response.data.status !== 'completed') return
    const graph = session.contentGraph ?? emptyContentGraph()
    if (['running', 'completed'].includes(graph.jobs[responseId]?.status)) return
    const attemptId = crypto.randomUUID()
    const key = `${session.id}:${responseId}`
    const abort = new AbortController()
    structureRequests.set(key, abort)
    updateSession(session.id, (current) => {
      const contentGraph = current.contentGraph ?? emptyContentGraph()
      return {
        ...current,
        contentGraph: {
          ...contentGraph,
          jobs: { ...contentGraph.jobs, [responseId]: { status: 'running', attemptId } },
        },
      }
    })
    try {
      const textHash = await hashText(response.data.text)
      if (abort.signal.aborted) return
      let result: unknown = { version: 2, text_hash: textHash, items: [] }
      if (response.data.text.trim()) {
        if (!response.data.continuation) throw Error('missing_context')
        const res = await fetch('/api/structure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            request_id: attemptId,
            continuation: response.data.continuation,
            text_hash: textHash,
          }),
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]),
        })
        if (!res.ok) throw Error('structure_failed')
        result = await res.json()
      }
      const validated = validateStructure(result, response.data.text, textHash)
      if (abort.signal.aborted) return
      updateSession(session.id, (current) => {
        if (
          current.contentGraph?.jobs[responseId]?.attemptId !== attemptId ||
          current.contentGraph.jobs[responseId].status !== 'running' ||
          responseById(current, responseId)?.data.text !== response.data.text
        )
          return current
        const next = attachInformation(current, responseId, validated)
        return {
          ...finishResponseStructure(next, responseId, 'completed'),
          contentGraph: {
            ...next.contentGraph!,
            jobs: { ...next.contentGraph!.jobs, [responseId]: { status: 'completed', attemptId, textHash } },
          },
        }
      })
    } catch {
      if (!abort.signal.aborted)
        updateSession(session.id, (current) => {
          const contentGraph = current.contentGraph
          if (
            contentGraph?.jobs[responseId]?.attemptId !== attemptId ||
            contentGraph.jobs[responseId].status !== 'running'
          )
            return current
          return {
            ...finishResponseStructure(current, responseId, 'failed'),
            contentGraph: {
              ...contentGraph,
              jobs: {
                ...contentGraph.jobs,
                [responseId]: {
                  status: 'failed',
                  attemptId,
                  error: '정보 노드를 만들지 못했습니다. 원래 답변은 유지됩니다.',
                },
              },
            },
          }
        })
    } finally {
      if (structureRequests.get(key) === abort) structureRequests.delete(key)
    }
  },
  initialize: () => {
    if (initialization) return initialization
    set({ retryingServer: true })
    initialization = (async () => {
      try {
        await persistence
        set({ storageError: null })
        const history = await loadSessions((storageError) => set({ storageError }))
        set({ serverError: false, history: history.map(restoreSession) })
      } catch {
        set({ serverError: true, storageError: null })
      }
    })().finally(() => {
      initialization = undefined
      set({ retryingServer: false })
    })
    return initialization
  },
  setInput: (input) => set({ input }),
  requestedTool: null,
  setRequestedTool: (requestedTool) => set({ requestedTool }),
  newConversation: () => {
    historyController?.abort()
    historyController = undefined
    set({ loadingSessionId: null, failedSessionId: null })
    cancelSessionStructures()
    get().stop()
    set({ session: null, requestedTool: null, selected: null, selectedEdge: null, input: '', error: null, replyTo: null, navigation: null })
  },
  open: async (id) => {
    if (get().loadingSessionId === id) return
    historyController?.abort()
    const abort = new AbortController()
    historyController = abort
    cancelSessionStructures()
    get().stop()
    set({ loadingSessionId: id, failedSessionId: null, selected: null, selectedEdge: null, navigation: null })
    try {
      await persistence
      const session = restoreSession(await loadSession(id, abort.signal))
      if (abort.signal.aborted) return
      set((state) => ({
        session,
        history: [session, ...state.history.filter((item) => item.id !== id)].sort((a, b) => b.updatedAt - a.updatedAt),
        input: '', requestedTool: null, error: null, replyTo: null, serverError: false,
      }))
    } catch {
      if (!abort.signal.aborted) set({ serverError: true, failedSessionId: id })
    } finally {
      if (historyController === abort) {
        historyController = undefined
        set({ loadingSessionId: null })
      }
    }
  },
  remove: async (id) => {
    if (get().session?.id === id || get().loadingSessionId === id) get().newConversation()
    // Remove only after the server confirms deletion; failures keep the history accessible.
    await persistence
    try {
      await deleteSession(id)
      set({ history: get().history.filter((s) => s.id !== id) })
    } catch (error) {
      set({ storageError: error instanceof Error ? error.message : '서버 기록을 삭제하지 못했습니다.' })
    }
  },
  reply: (id) => {
    if (get().activeRequest) return
    set({ replyTo: get().replyTo === id ? null : id })
  },
  toggleNode: (id) => {
    const session = get().session
    if (!session) return
    commit({ ...session, nodes: session.nodes.map((node) => {
      if (node.id !== id || node.type === 'response') return node
      const { height: _height, ...rest } = node
      return { ...rest, data: { ...node.data, collapsed: !node.data.collapsed } } as CanvasNode
    }) })
  },
  toggleResponse: (id) => {
    const session = get().session
    if (session)
      commit({
        ...session,
        nodes: session.nodes.map((n) =>
          n.type === 'response' && n.id === id
            ? { ...n, data: { ...n.data, collapsed: !n.data.collapsed } }
            : n,
        ),
      })
  },
  select: (id) => set({ selected: id, selectedEdge: null }),
  selectEdge: (index) => set({ selectedEdge: index, selected: null }),
  stop: () => {
    const state = get()
    if (!state.activeRequest) return
    clearTimeout(saveTimer)
    saveTimer = undefined
    controller?.abort()
    if (access)
      void fetch(`/api/jobs/${access.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${access.token}` },
      }).catch(() => {})
    controller = undefined
    access = undefined
    set({ activeRequest: null, responseId: null, stage: '' })
    if (state.session) commit(finishResponseTiming(finish(state.session, 'cancelled'), state.activeRequest, 'cancelled'))
  },
  run: async (options = {}) => {
    const before = get()
    if (before.activeRequest) return
    const latest = before.session?.nodes.filter((n): n is ResponseNode => n.type === 'response').at(-1)
    const query = options.retry
      ? before.session?.lastQuery || before.pendingQuery || latest?.data.prompt
      : before.input.trim()
    if (!query) return
    const reusable = before.session?.protocol === 2 && before.session.mode === 'live'
    if (reusable && before.session!.nodes.length && !before.session!.continuation) {
      set({ error: '이전 대화를 이어갈 정보가 없습니다. 새 대화를 시작해 주세요.' })
      return
    }
    const session = reusable ? { ...before.session! } : emptySession(query)
    const context = options.retry ? session.lastNodeContext : nodeContext(before.session, before.replyTo)
    const requestedTool = options.retry ? session.lastRequestedTool : before.requestedTool ?? undefined
    if (requestedTool === 'read_page' && !/https?:\/\/[^\s<>]+/.test(query + (context?.text ?? ''))) {
      set({ error: 'URL 접근을 사용하려면 질문에 http:// 또는 https:// 주소를 넣어 주세요.' })
      return
    }
    const parentId = options.retry
      ? session.lastParentId
      : (before.replyTo ??
        session.nodes.filter((n) => n.type === 'response' && n.data.status === 'completed').at(-1)?.id ??
        null)
    const parent = session.nodes.find((n): n is ResponseNode => n.type === 'response' && n.id === parentId)
    const continuation = options.retry
      ? session.continuation
      : (parent?.data.continuation ?? session.continuation)
    if (before.replyTo && !context && (!parent?.data.continuation || parent.data.status !== 'completed')) {
      set({ error: '이 응답의 대화 문맥이 없습니다. 새 응답에서 이어서 질문해 주세요.' })
      return
    }
    session.continuation = continuation
    session.lastParentId = parentId

    session.lastNodeContext = context
    session.lastQuery = query
    session.lastRequestedTool = requestedTool
    session.status = 'running'
    session.updatedAt = Date.now()
    session.failedParts = []
    const requestId = crypto.randomUUID()
    session.responseTimings = { ...session.responseTimings, [requestId]: startResponseTiming(requestId) }
    const abort = new AbortController()
    controller = abort
    set({
      session,
      activeRequest: requestId,
      responseId: null,
      pendingQuery: query,
      pendingParentId: parentId ?? null,
      replyTo: null,
      lastSeq: 0,
      stage: '응답을 준비하고 있어요',
      error: null,
      selected: null,
      selectedEdge: null,
      input: '',
      requestedTool: null,
    })
    try {
      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abort.signal,
        body: JSON.stringify({
          query,
          node_context: context,
          request_id: requestId,
          continuation: reusable ? continuation : undefined,
          requested_tool: requestedTool,
        } satisfies AgentRequest),
      })
      await consumeSSE(response, get().receive, abort.signal)
    } catch {
      if (get().activeRequest !== requestId || abort.signal.aborted) return
      set({ error: '응답을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.' })
      const current = get().session
      if (current)
        commit(
          finishResponseTiming(finish(
            current,
            current.nodes.some((n) => n.type === 'response' && n.id === get().responseId && n.data.text)
              ? 'partial'
              : 'failed',
          ), requestId, 'failed'),
        )
    } finally {
      if (get().activeRequest === requestId) {
        const current = get().session
        // An SSE connection ending without `done` must not leave a live timer behind.
        if (current?.status === 'running')
          commit(finishResponseTiming(finish(current, 'partial'), requestId, 'failed'))
        set({ activeRequest: null, responseId: null, stage: '' })
        access = undefined
        controller = undefined
      }
    }
  },
  receive: (event) => {
    const state = get()
    if (
      event.version !== 2 ||
      event.request_id !== state.activeRequest ||
      event.seq <= state.lastSeq ||
      !state.session
    )
      return
    set({ lastSeq: event.seq })
    const session = { ...state.session }
    switch (event.type) {
      case 'started':
        access = { id: event.job_id, token: String(event.data.access_token) }
        break
      case 'status':
        set({ stage: event.data.stage === 'reading_sources' ? '출처 본문을 읽고 있어요' : '응답을 작성하고 있어요' })
        break
      case 'response_started': {
        if (state.responseId) break
        const id = String(event.data.id)
        const width = Math.min(560, window.innerWidth - 48)
        const parent = session.nodes.find((n) => n.id === state.pendingParentId)
        const x = parent ? parent.position.x + (parent.width || 560) + 64 : 0
        const column = session.nodes.filter(
          (n) => n.position.x < x + width && n.position.x + (n.width || 560) > x,
        )
        const y = column.length
          ? Math.max(...column.map((n) => n.position.y + (n.measured?.height ?? n.height ?? 400))) + 64
          : (parent?.position.y ?? 0)
        const node: ResponseNode = {
          id,
          type: 'response',
          width,
          position: { x, y },
          data: {
            parentId: state.pendingParentId,
            prompt: state.pendingQuery,
            requestedTool: session.lastRequestedTool,
            text: '',
            status: 'streaming',
          },
        }
        session.nodes = [...session.nodes, node]
        const timing = session.responseTimings?.[state.activeRequest!]
        if (timing) session.responseTimings = {
          ...session.responseTimings, [state.activeRequest!]: { ...timing, responseId: id },
        }
        if (session.lastNodeContext && session.nodes.some((n) => n.id === session.lastNodeContext!.node_id)) {
          const graph = session.contentGraph ?? emptyContentGraph()
          const target = session.lastNodeContext.node_id
          session.contentGraph = { ...graph, relations: [...graph.relations, {
            id: `uses_context:${id}:${target}`, source: id, target, kind: 'uses_context', responseId: id, spans: [],
          }] }
        }
        set({ responseId: id })
        commit(session)
        break
      }
      case 'response_delta':
      case 'response_completed': {
        if (event.data.id !== state.responseId) break
        session.nodes = session.nodes.map((n) =>
          n.type === 'response' && n.id === state.responseId
            ? {
                ...n,
                data: {
                  ...n.data,
                  text:
                    event.type === 'response_delta'
                      ? n.data.text + String(event.data.delta)
                      : String(event.data.text),
                  status: event.type === 'response_completed' ? 'completed' : 'streaming',
                },
              }
            : n,
        )
        if (event.type === 'response_completed') commit(session)
        else {
          set({ session })
          if (!saveTimer)
            saveTimer = setTimeout(() => {
              saveTimer = undefined
              const current = get().session
              if (current?.id === session.id) commit(current)
            }, 500)
        }
        break
      }
      case 'response_sources': {
        if (event.data.id !== state.responseId) break
        const sources = parseToolSources(event.data.sources)
        if (!sources) break
        session.nodes = session.nodes.map((n) =>
          n.type === 'response' && n.id === state.responseId
            ? { ...n, data: { ...n.data, toolSources: sources } }
            : n,
        )
        commit(attachSources(session, state.responseId!))
        break
      }
      case 'part_error': {
        session.failedParts = ['response']
        set({ session, error: '응답을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.' })
        break
      }
      case 'checkpoint':
        session.continuation = String(event.data.continuation)
        session.nodes = session.nodes.map((n) =>
          n.type === 'response' && n.id === state.responseId && n.data.status === 'completed'
            ? { ...n, data: { ...n.data, continuation: session.continuation } }
            : n,
        )
        commit(session)
        break
      case 'done':
        commit(attachSources(
          event.data.status === 'completed'
            ? finish(session, 'completed')
            : finishResponseTiming(finish(session, event.data.status as Session['status']), state.activeRequest,
              event.data.status === 'cancelled' ? 'cancelled' : 'failed'),
          state.responseId!,
        ))
        if (event.data.status === 'completed') {
          if (state.responseId) void get().structure(state.responseId)
          else commit(finishResponseTiming(get().session!, state.activeRequest, 'failed'))
          void generateTitle(get().session!)
        }
        break
    }
  },
  nodesChange: (changes) => {
    const session = get().session
    if (!session) return
    const selection = changes.find((c) => c.type === 'select' && c.selected)
    if (selection?.type === 'select') set({ selected: selection.id, selectedEdge: null })
    const moved = changes.flatMap((c) => (c.type === 'position' && c.position ? [c.id] : []))
    const next = {
      ...session,
      nodes: applyNodeChanges(changes, session.nodes),
      pinned: [...new Set([...session.pinned, ...moved])],
    }
    set({ session: next })
    if (moved.length && changes.some((c) => c.type === 'position' && !c.dragging)) commit(next)
  },
  viewport: (viewport) => {
    const session = get().session
    if (session) commit({ ...session, viewport })
  },
  markFitted: () => {
    const session = get().session
    if (session) commit({ ...session, fitted: true })
  },
}))
