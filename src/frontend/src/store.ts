import { emptyEdits, defaultConnectionLabel, editLocked, visibleNodes, nodeDraft, validateDraft, visibleLinks } from './lib/canvasEditing'
import type { CanvasEdits, UserNodeData, UserEdge } from './types'
import { appendResponse, attachmentLimits, deleteDraftAttachment, uploadAttachment } from './lib/attachments'
import { nodeContext } from './lib/nodeActions'
import { create } from 'zustand'
import { applyNodeChanges, type NodeChange, type Viewport, type Connection } from '@xyflow/react'
import type { CanvasNode, Envelope, Session, ResponseNode, RequestedTool, AgentRequest, DraftAttachment, Attachment } from './types'
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
interface RunningJob {
  requestId: string
  sessionId: string
  controller: AbortController
  access?: { id: string; token: string }
  responseId: string | null
  pendingQuery: string
  pendingParentId: string | null
  lastSeq: number
  stage: string
}
const jobs = new Map<string, RunningJob>()
let persistence: Promise<unknown> = Promise.resolve()
let historyController: AbortController | undefined
let initialization: Promise<void> | undefined
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const uploadRequests = new Map<string, AbortController>()
const structureRequests = new Map<string, AbortController>()
function persist(session: Session) {
  if (session.readOnly) return
  const snapshot = structuredClone(session)
  persistence = persistence
    .catch(() => {})
    .then(() => saveSession(snapshot))
    .catch((error: unknown) => {
      useStore.setState({ storageError: error instanceof Error ? error.message : '서버에 기록을 저장하지 못했습니다.' })
    })
}
interface State {
  undoStack: CanvasEdits[]
  redoStack: CanvasEdits[]
  clipboard: { data: UserNodeData; width: number } | null
  actionNotice: { id: string; message: string } | null
  editingDraft: UserNodeData | null
  editingNode: string | null
  editingEdge: string | null
  selectedLink: string | null
  editNode: (id: string | null) => void
  editEdge: (id: string | null) => void
  copyNode: (id: string) => void
  createNode: (position: { x: number; y: number }, viewport?: Viewport) => void
  pasteNode: (position?: { x: number; y: number }, viewport?: Viewport) => void
  saveNode: (id: string, data: UserNodeData) => boolean
  deleteNode: (id: string) => void
  saveEdge: (edge: UserEdge) => void
  connect: (connection: Connection) => void
  deleteEdge: (id: string) => void
  undo: () => void
  redo: () => void

  session: Session | null
  history: Session[]
  loadingSessionId: string | null
  failedSessionId: string | null
  input: string
  draftAttachments: DraftAttachment[]
  addAttachments: (files: File[]) => Promise<void>
  removeAttachment: (localId: string) => void
  reuseAttachment: (attachment: Attachment) => void
  clearAttachments: () => void
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
  if (session.readOnly) { useStore.setState({ session }); return }
  useStore.setState((state) => ({
    session,
    history: [session, ...state.history.filter((s) => s.id !== session.id)].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    ),
  }))
  persist(session)
}
function commitSession(session: Session) {
  if (useStore.getState().session?.id === session.id) commit(session)
  else {
    useStore.setState((state) => ({
      history: [session, ...state.history.filter((item) => item.id !== session.id)].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      ),
    }))
    persist(session)
  }
}
function jobForSession(sessionId: string | undefined) {
  if (!sessionId) return undefined
  return [...jobs.values()].find((job) => job.sessionId === sessionId)
}
function scheduleSessionPersist(session: Session) {
  if (saveTimers.has(session.id)) return
  saveTimers.set(session.id, setTimeout(() => {
    saveTimers.delete(session.id)
    const current = useStore.getState().session?.id === session.id
      ? useStore.getState().session
      : useStore.getState().history.find((item) => item.id === session.id)
    if (current) commitSession(current)
  }, 500))
}
function notifyAction(message: string) {
  useStore.setState({ actionNotice: { id: crypto.randomUUID(), message } })
}
function commitEdits(edits: CanvasEdits) {
  const state = useStore.getState()
  if (editLocked(state.session) || state.activeRequest || state.loadingSessionId) return false
  useStore.setState({ undoStack: [...state.undoStack.slice(-49), structuredClone(state.session!.canvasEdits ?? emptyEdits())], redoStack: [] })
  commit({ ...state.session!, canvasEdits: edits, updatedAt: Date.now() })
  return true
}
let dragBefore: CanvasEdits | undefined
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
  commitSession({ ...session, titleRequested: true })
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
    commitSession(updated)
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
  undoStack: [], redoStack: [], clipboard: null, actionNotice: null, editingDraft: null, editingNode: null, editingEdge: null, selectedLink: null,
  editNode: (id) => { if (id && (!get().session || get().session?.readOnly)) return; set({ editingDraft: id && get().session ? nodeDraft(get().session!, id) : null, editingNode: id, editingEdge: null, ...(id ? { selected: id, selectedLink: null } : {}) }) },
  editEdge: (id) => { if (id && (!get().session || get().session?.readOnly)) return; set({ editingEdge: id, editingDraft: null, editingNode: null, selectedLink: id, selected: null }) },
  copyNode: (id) => {
    const session = get().session
    const data = session && nodeDraft(session, id)
    const node = visibleNodes(session).find(n => n.id === id)
    if (!data || !node) return
    set({ clipboard: { data, width: node.width ?? node.measured?.width ?? (data.kind === 'response' ? 560 : data.kind === 'entity' ? 340 : 460) } })
    notifyAction('복사를 완료했습니다')
  },
  createNode: (position) => {
    if (!get().session || get().activeRequest || get().loadingSessionId || editLocked(get().session)) return
    const session = get().session!
    const id = `user_${crypto.randomUUID()}`
    const edits = structuredClone(session.canvasEdits ?? emptyEdits())
    edits.nodes.push({ id, type: 'user', position, width: 560, data: { kind: 'response', title: '새 질문', text: '', url: '', imageUrl: '', label: '완료' } })
    if (!commitEdits(edits)) return
    set({ selected: id, selectedLink: null, editingDraft: nodeDraft(get().session!, id), editingNode: id, editingEdge: null })
    notifyAction('노드 생성을 완료했습니다')
  },
  pasteNode: (position) => {
    const clipboard = get().clipboard
    if (!get().session || !clipboard || get().activeRequest || get().loadingSessionId || editLocked(get().session)) return
    const session = get().session!
    const selected = visibleNodes(session).find(n => n.id === get().selected)
    const id = `user_${crypto.randomUUID()}`
    const edits = structuredClone(session.canvasEdits ?? emptyEdits())
    edits.nodes.push({ id, type: 'user', position: position ?? { x: (selected?.position.x ?? 0) + 80, y: (selected?.position.y ?? 0) + 80 }, width: clipboard.width, data: structuredClone(clipboard.data) })
    if (!commitEdits(edits)) return false
    set({ selected: id, selectedLink: null })
    notifyAction('붙여넣기를 완료했습니다')
  },
  saveNode: (id, data) => {
    const session = get().session
    if (!session || editLocked(session) || validateDraft(data)) return false
    const node = visibleNodes(session).find(n => n.id === id)
    if (!node) return false
    const edits = structuredClone(session.canvasEdits ?? emptyEdits())
    const previous = nodeDraft(session, id)!
    const saved = structuredClone(data)
    if (['kind', 'title', 'text', 'url', 'imageUrl'].some(key => previous[key as keyof UserNodeData] !== data[key as keyof UserNodeData])) {
      delete saved.attachment
      delete saved.page
    }
    if (previous.kind !== data.kind || previous.text !== data.text) delete saved.presentation
    else if (saved.presentation) saved.presentation.heading = data.title
    const width = previous.kind === data.kind ? node.width : data.kind === 'response' ? 560 : data.kind === 'entity' ? 340 : 460
    edits.nodes = [...edits.nodes.filter(n => n.id !== id), { id, type: 'user', position: node.position, width, data: saved }]
    if (!commitEdits(edits)) return false
    set({ editingDraft: null, editingNode: null, replyTo: get().replyTo === id ? null : get().replyTo })
    notifyAction('수정을 완료했습니다')
    return true
  },
  deleteNode: (id) => {
    const session = get().session
    if (!session || editLocked(session) || !visibleNodes(session).some(n => n.id === id)) return
    const edits = structuredClone(session.canvasEdits ?? emptyEdits())
    edits.hiddenNodes.push(id)
    if (!commitEdits(edits)) return false
    set({ selected: null, selectedLink: null, editingDraft: null, editingNode: null, replyTo: get().replyTo === id ? null : get().replyTo })
    notifyAction('삭제를 완료했습니다')
  },
  connect: (connection) => {
    const session = get().session
    if (editLocked(session) || !connection.source || !connection.target || connection.source === connection.target) return
    if (visibleLinks(session).some(e => e.source === connection.source && e.target === connection.target && (e.sourceHandle ?? null) === connection.sourceHandle && (e.targetHandle ?? null) === connection.targetHandle)) return
    const id = `manual_${crypto.randomUUID()}`
    get().saveEdge({ ...connection, id, label: defaultConnectionLabel(session, connection.source, connection.target) })
    if (get().session?.canvasEdits?.edges.some(e => e.id === id)) { set({ editingEdge: id }); notifyAction('연결을 완료했습니다') }
  },
  saveEdge: (edge) => {
    const session = get().session
    if (!session || editLocked(session)) return
    const ids = visibleNodes(session).map(n => n.id)
    if (edge.source === edge.target || !ids.includes(edge.source) || !ids.includes(edge.target)) return
    const edits = structuredClone(session.canvasEdits ?? emptyEdits())
    edits.edges = [...edits.edges.filter(e => e.id !== edge.id), { ...edge, label: edge.label.trim() || defaultConnectionLabel(session, edge.source, edge.target) }]
    if (!commitEdits(edits)) return false
    set({ editingEdge: null })
    notifyAction('수정을 완료했습니다')
  },
  deleteEdge: (id) => {
    const session = get().session
    if (!session || editLocked(session) || !visibleLinks(session).some(e => e.id === id)) return
    const edits = structuredClone(session.canvasEdits ?? emptyEdits())
    edits.hiddenEdges.push(id)
    if (!commitEdits(edits)) return false
    set({ selectedLink: null, editingEdge: null })
    notifyAction('삭제를 완료했습니다')
  },
  undo: () => {
    const { session, undoStack, redoStack } = get()
    if (!session || editLocked(session) || !undoStack.length) return
    set({ undoStack: undoStack.slice(0, -1), redoStack: [...redoStack, structuredClone(session.canvasEdits ?? emptyEdits())], selected: null, selectedLink: null, editingDraft: null, editingNode: null, editingEdge: null })
    const edits = undoStack.at(-1)!
    commit({ ...session, canvasEdits: edits, nodes: session.nodes.map(n => ({ ...n, position: edits.positions[n.id] ?? n.position })), updatedAt: Date.now() })
  },
  redo: () => {
    const { session, undoStack, redoStack } = get()
    if (!session || editLocked(session) || !redoStack.length) return
    set({ undoStack: [...undoStack, structuredClone(session.canvasEdits ?? emptyEdits())], redoStack: redoStack.slice(0, -1), selected: null, selectedLink: null, editingDraft: null, editingNode: null, editingEdge: null })
    const edits = redoStack.at(-1)!
    commit({ ...session, canvasEdits: edits, nodes: session.nodes.map(n => ({ ...n, position: edits.positions[n.id] ?? n.position })), updatedAt: Date.now() })
  },
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
    if (!session || session.readOnly || session.protocol !== 2 || session.mode !== 'live') return
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
  draftAttachments: [],
  clearAttachments: () => {
    for (const draft of get().draftAttachments) get().removeAttachment(draft.localId)
  },
  removeAttachment: (localId) => {
    uploadRequests.get(localId)?.abort()
    uploadRequests.delete(localId)
    const draft = get().draftAttachments.find(a => a.localId === localId)
    set(state => ({draftAttachments: state.draftAttachments.filter(a => a.localId !== localId)}))
    if (draft?.attachment && !draft.reused) void deleteDraftAttachment(draft.attachment.id)
  },
  reuseAttachment: (attachment) => {
    if (get().session?.readOnly) return
    const state = get()
    if (state.activeRequest || state.draftAttachments.some(draft => draft.attachment?.id === attachment.id)) return
    if (state.draftAttachments.length >= 4) { set({error: '첨부는 한 번에 최대 4개까지 추가할 수 있어요.'}); return }
    set({draftAttachments: [...state.draftAttachments, {localId: crypto.randomUUID(), name: attachment.name,
      status: 'ready', attachment, reused: true}], error: null})
  },
  addAttachments: async (files) => {
    if (get().activeRequest || !files.length) return
    const available = 4 - get().draftAttachments.length
    if (files.length > available) {
      set({error: '첨부는 한 번에 최대 4개까지 추가할 수 있어요.'})
      return
    }
    const drafts = files.map(file => ({localId: crypto.randomUUID(), name: file.name, status: 'uploading' as const}))
    set(state => ({draftAttachments: [...state.draftAttachments, ...drafts], error: null}))
    await Promise.all(drafts.map(async (draft, index) => {
      const abort = new AbortController()
      uploadRequests.set(draft.localId, abort)
      try {
        const limits = await attachmentLimits()
        if (abort.signal.aborted) return
        if (get().draftAttachments.length > limits.max_count) throw Error(`첨부는 최대 ${limits.max_count}개까지 추가할 수 있어요.`)
        if (files[index].size > limits.max_bytes) throw Error(`파일은 ${(limits.max_bytes / 1000000).toFixed(1)}MB 이하로 첨부해 주세요.`)
        const attachment = await uploadAttachment(files[index], abort.signal)
        if (abort.signal.aborted || !get().draftAttachments.some(a => a.localId === draft.localId)) {
          void deleteDraftAttachment(attachment.id)
          return
        }
        set(state => ({draftAttachments: state.draftAttachments.map(a => a.localId === draft.localId ? {...a, status: 'ready', attachment} : a)}))
      } catch (error) {
        if (!abort.signal.aborted) set(state => ({draftAttachments: state.draftAttachments.map(a => a.localId === draft.localId
          ? {...a, status: 'failed', error: error instanceof Error ? error.message : '첨부를 업로드하지 못했어요.'} : a)}))
      } finally { uploadRequests.delete(draft.localId) }
    }))
  },
  requestedTool: null,
  setRequestedTool: (requestedTool) => set({ requestedTool }),
  newConversation: () => {
    set({ actionNotice: null, undoStack: [], redoStack: [], editingDraft: null, editingNode: null, editingEdge: null, selectedLink: null })
    dragBefore = undefined
    get().clearAttachments()
    historyController?.abort()
    historyController = undefined
    set({ loadingSessionId: null, failedSessionId: null })
    cancelSessionStructures()
    set({ session: null, requestedTool: null, selected: null, selectedEdge: null, input: '', error: null, replyTo: null, navigation: null })
    set({ activeRequest: null, responseId: null, stage: '' })
  },
  open: async (id) => {
    set({ actionNotice: null, undoStack: [], redoStack: [], editingDraft: null, editingNode: null, editingEdge: null, selectedLink: null })
    dragBefore = undefined
    get().clearAttachments()
    if (get().loadingSessionId === id) return
    historyController?.abort()
    const abort = new AbortController()
    historyController = abort
    cancelSessionStructures()
    set({ loadingSessionId: id, failedSessionId: null, selected: null, selectedEdge: null, navigation: null })
    try {
      await persistence
      const session = restoreSession(await loadSession(id, abort.signal))
      if (abort.signal.aborted) return
      set((state) => ({
        session,
        history: [session, ...state.history.filter((item) => item.id !== id)].sort((a, b) => b.updatedAt - a.updatedAt),
        input: '', requestedTool: null, error: null, replyTo: null, serverError: false,
        activeRequest: jobForSession(id)?.requestId ?? null,
        responseId: jobForSession(id)?.responseId ?? null,
        stage: jobForSession(id)?.stage ?? '',
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
    const job = jobForSession(id)
    if (job) {
      job.controller.abort()
      jobs.delete(job.requestId)
    }
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
    if (get().session?.readOnly) return
    if (get().activeRequest) return
    set({ replyTo: get().replyTo === id ? null : id })
  },
  toggleNode: (id) => {
    const session = get().session
    if (!session) return
    if (session.canvasEdits?.nodes.some(n => n.id === id)) {
      commit({ ...session, canvasEdits: { ...session.canvasEdits, nodes: session.canvasEdits.nodes.map(n => n.id === id ? { ...n, data: { ...n.data, collapsed: !n.data.collapsed } } : n) } })
      return
    }
    commit({ ...session, nodes: session.nodes.map((node) => {
      if (node.id !== id || node.type === 'response') return node
      const { height: _height, ...rest } = node
      return { ...rest, data: { ...node.data, collapsed: !(node.data.collapsed ?? (node.type === 'attachment')) } } as CanvasNode
    }) })
  },
  toggleResponse: (id) => {
    const session = get().session
    if (session?.canvasEdits?.nodes.some(n => n.id === id)) { get().toggleNode(id); return }
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
  select: (id) => set({ selected: id, selectedEdge: null, selectedLink: null }),
  selectEdge: (index) => set({ selectedEdge: index, selected: null }),
  stop: () => {
    const state = get()
    if (!state.activeRequest) return
    const job = jobs.get(state.activeRequest)
    if (!job) return
    const pendingSave = saveTimers.get(job.sessionId)
    if (pendingSave) {
      clearTimeout(pendingSave)
      saveTimers.delete(job.sessionId)
    }
    job.controller.abort()
    if (job.access)
      void fetch(`/api/jobs/${job.access.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${job.access.token}` },
      }).catch(() => {})
    jobs.delete(job.requestId)
    set({ activeRequest: null, responseId: null, stage: '' })
    if (state.session) commit(finishResponseTiming(finish(state.session, 'cancelled'), state.activeRequest, 'cancelled'))
  },
  run: async (options = {}) => {
    const before = get()
    if (jobForSession(before.session?.id) || before.session?.readOnly) return
    const latest = before.session?.nodes.filter((n): n is ResponseNode => n.type === 'response').at(-1)
    if (!options.retry && before.draftAttachments.some(a => a.status !== 'ready')) {
      set({error: '첨부 업로드를 완료하거나 실패한 첨부를 제거해 주세요.'})
      return
    }
    const attachments: Attachment[] = options.retry ? before.session?.lastAttachments ?? []
      : before.draftAttachments.flatMap(a => a.attachment ? [a.attachment] : [])
    const query = options.retry
      ? before.session?.lastQuery || before.pendingQuery || latest?.data.prompt
      : before.input.trim() || (attachments.length ? '첨부한 자료를 설명해 주세요.' : '')
    if (!query) return
    const reusable = before.session?.protocol === 2 && before.session.mode === 'live'
    const retryUnstartedAttachment = options.retry && attachments.length > 0 && !before.session?.lastParentId
      && before.session?.nodes.every(n => n.type !== 'response' || (!n.data.text && n.data.status !== 'completed'))
    if (reusable && before.session!.nodes.length && !before.session!.continuation && !retryUnstartedAttachment) {
      set({ error: '이전 대화를 이어갈 정보가 없습니다. 새 대화를 시작해 주세요.' })
      return
    }
    let session = reusable ? { ...before.session! } : emptySession(query)
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
    const parent = visibleNodes(session).find((n): n is ResponseNode => n.type === 'response' && n.id === parentId)
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
    session.lastAttachments = attachments
    session.status = 'running'
    session.updatedAt = Date.now()
    session.failedParts = []
    const requestId = crypto.randomUUID()
    session.responseTimings = { ...session.responseTimings, [requestId]: startResponseTiming(requestId) }
    const initialResponseId = attachments.length ? `response_${requestId}` : null
    if (initialResponseId) session = appendResponse(session, initialResponseId, requestId, parentId ?? null, query, attachments)
    const abort = new AbortController()
    jobs.set(requestId, {
      requestId,
      sessionId: session.id,
      controller: abort,
      responseId: initialResponseId,
      pendingQuery: query,
      pendingParentId: parentId ?? null,
      lastSeq: 0,
      stage: '응답을 준비하고 있어요',
    })
    set({
      session,
      activeRequest: requestId,
      responseId: initialResponseId,
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
      draftAttachments: options.retry ? before.draftAttachments : [],
    })
    // Persist the running session before streaming so it remains addressable
    // if the user opens another conversation immediately.
    commit(session)
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
          attachment_ids: attachments.length ? attachments.map(a => a.id) : undefined,
        } satisfies AgentRequest),
      })
      await consumeSSE(response, get().receive, abort.signal)
    } catch {
      const currentState = get()
      const current = currentState.session?.id === session.id
        ? currentState.session
        : currentState.history.find((item) => item.id === session.id)
      if (abort.signal.aborted) return
      if (currentState.session?.id === session.id) set({ error: '응답을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.' })
      if (current)
        commitSession(
          finishResponseTiming(finish(
            current,
            current.nodes.some((n) => n.type === 'response' && n.id === jobs.get(requestId)?.responseId && n.data.text)
              ? 'partial'
              : 'failed',
          ), requestId, 'failed'),
        )
    } finally {
      const job = jobs.get(requestId)
      const currentState = get()
      const current = currentState.session?.id === session.id
        ? currentState.session
        : currentState.history.find((item) => item.id === session.id)
      if (job && !abort.signal.aborted && current?.status === 'running')
        commitSession(finishResponseTiming(finish(current, 'partial'), requestId, 'failed'))
      jobs.delete(requestId)
      if (currentState.activeRequest === requestId) set({ activeRequest: null, responseId: null, stage: '' })
    }
  },
  receive: (event) => {
    const state = get()
    let job = jobs.get(event.request_id)
    // Keep direct store consumers and older persisted UI state compatible while
    // all new requests use the session-scoped job registry above.
    if (!job && state.activeRequest === event.request_id && state.session) {
      job = {
        requestId: event.request_id,
        sessionId: state.session.id,
        controller: new AbortController(),
        responseId: state.responseId,
        pendingQuery: state.pendingQuery,
        pendingParentId: state.pendingParentId,
        lastSeq: state.lastSeq,
        stage: state.stage,
      }
      jobs.set(event.request_id, job)
    }
    if (event.version !== 2 || !job || event.seq <= job.lastSeq) return
    const source = state.session?.id === job.sessionId
      ? state.session
      : state.history.find((item) => item.id === job.sessionId)
    if (!source) return
    job.lastSeq = event.seq
    const foreground = state.session?.id === job.sessionId
    const session = { ...source }
    switch (event.type) {
      case 'started':
        job.access = { id: event.job_id, token: String(event.data.access_token) }
        break
      case 'status':
        job.stage = event.data.stage === 'reading_sources' ? '출처 본문을 읽고 있어요' : '응답을 작성하고 있어요'
        if (foreground) set({ stage: job.stage })
        break
      case 'response_started': {
        const id = String(event.data.id)
        if (job.responseId && job.responseId !== id) break
        job.responseId = id
        Object.assign(session, appendResponse(session, id, job.requestId, job.pendingParentId, job.pendingQuery, session.lastAttachments ?? []))
        if (session.lastNodeContext && visibleNodes(session).some((n) => n.id === session.lastNodeContext!.node_id)) {
          const graph = session.contentGraph ?? emptyContentGraph()
          const target = session.lastNodeContext.node_id
          session.contentGraph = { ...graph, relations: [...graph.relations, {
            id: `uses_context:${id}:${target}`, source: id, target, kind: 'uses_context', responseId: id, spans: [],
          }] }
        }
        if (foreground) set({ responseId: id })
        commitSession(session)
        break
      }
      case 'response_delta':
      case 'response_completed': {
        if (event.data.id !== job.responseId) break
        session.nodes = session.nodes.map((n) =>
          n.type === 'response' && n.id === job.responseId
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
        if (event.type === 'response_completed') commitSession(session)
        else {
          if (foreground) set({ session })
          scheduleSessionPersist(session)
        }
        break
      }
      case 'response_sources': {
        if (event.data.id !== job.responseId) break
        const sources = parseToolSources(event.data.sources)
        if (!sources) break
        session.nodes = session.nodes.map((n) =>
          n.type === 'response' && n.id === job.responseId
            ? { ...n, data: { ...n.data, toolSources: sources } }
            : n,
        )
        commitSession(attachSources(session, job.responseId!))
        break
      }
      case 'part_error': {
        session.failedParts = ['response']
        if (foreground) set({ session, error: '응답을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.' })
        commitSession(session)
        break
      }
      case 'checkpoint':
        session.continuation = String(event.data.continuation)
        session.nodes = session.nodes.map((n) =>
          n.type === 'response' && n.id === job.responseId && n.data.status === 'completed'
            ? { ...n, data: { ...n.data, continuation: session.continuation } }
            : n,
        )
        commitSession(session)
        break
      case 'done':
        commitSession(attachSources(
          event.data.status === 'completed'
            ? finish(session, 'completed')
            : finishResponseTiming(finish(session, event.data.status as Session['status']), job.requestId,
              event.data.status === 'cancelled' ? 'cancelled' : 'failed'),
          job.responseId!,
        ))
        if (event.data.status === 'completed') {
          if (foreground && job.responseId) void get().structure(job.responseId)
          const latest = get().session?.id === job.sessionId
            ? get().session
            : get().history.find((item) => item.id === job.sessionId)
          if (latest) void generateTitle(latest)
        }
        break
    }
  },
  nodesChange: (changes) => {
    const session = get().session
    if (!session) return
    if (session.readOnly) changes = changes.filter(c => c.type === 'dimensions' || c.type === 'select')
    const selection = changes.find(c => c.type === 'select' && c.selected)
    if (selection?.type === 'select') set({ selected: selection.id, selectedEdge: null, selectedLink: null })
    const moved = changes.filter(c => c.type === 'position' && c.position)
    let edits = session.canvasEdits
    if (moved.length) {
      if (!dragBefore) {
        dragBefore = structuredClone(edits ?? emptyEdits())
        const beforePositions = Object.fromEntries(visibleNodes(session).map(n => [n.id, n.position]))
        dragBefore.positions = beforePositions
        set({ undoStack: get().undoStack.map(snapshot => ({ ...snapshot, positions: { ...beforePositions, ...snapshot.positions } })) })
      }
      edits = structuredClone(edits ?? emptyEdits())
      edits.positions = { ...dragBefore.positions, ...edits.positions }
      for (const c of moved) if (c.type === 'position' && c.position) edits.positions[c.id] = c.position
    }
    if (edits) edits = { ...edits, nodes: applyNodeChanges(changes.filter(c => c.type !== 'remove' && c.type !== 'add' && c.type !== 'replace'), edits.nodes) }
    const next = { ...session, ...(edits ? { canvasEdits: edits } : {}),
      nodes: applyNodeChanges(changes.filter(c => c.type !== 'remove'), session.nodes) }
    set({ session: next })
    if (moved.some(c => c.type === 'position' && !c.dragging) && dragBefore) {
      const before = dragBefore
      dragBefore = undefined
      if (JSON.stringify(before.positions) !== JSON.stringify(edits?.positions)) {
        set({ undoStack: [...get().undoStack.slice(-49), before], redoStack: [] })
        commit({ ...next, pinned: [...new Set([...next.pinned, ...moved.flatMap(c => 'id' in c ? [c.id] : [])])] })
      }
    }
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
