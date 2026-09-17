import { create } from 'zustand'
import { applyNodeChanges, type NodeChange, type Viewport } from '@xyflow/react'
import type { Answer, Clarification, Envelope, Graph, PageNode, Session, Source, PartError } from './types'
import { deleteSession, loadSessions, saveSession } from './lib/db'
import { layoutPages } from './lib/layout'
import { consumeSSE } from './lib/sse'
import { makeSample, type SampleKind } from './lib/samples'

const emptySession = (query: string): Session => ({
  id: crypto.randomUUID(),
  query,
  updatedAt: Date.now(),
  mode: 'live',
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
function persist(session: Session) {
  const snapshot = structuredClone(session)
  persistence = persistence
    .catch(() => {})
    .then(() => saveSession(snapshot))
    .catch(() => {
      useStore.setState({ storageError: '브라우저 저장소를 사용할 수 없어 기록을 저장하지 못했습니다.' })
    })
}
interface State {
  session: Session | null
  history: Session[]
  input: string
  selected: string | null
  selectedEdge: number | null
  activeRequest: string | null
  lastSeq: number
  stage: string
  error: string | null
  storageError: string | null
  baseline: PageNode[]
  focusId?: string
  initialize: () => Promise<void>
  setInput: (input: string) => void
  newSearch: () => void
  open: (id: string) => void
  remove: (id: string) => Promise<void>
  sample: (kind: SampleKind) => void
  select: (id: string | null) => void
  selectEdge: (index: number | null) => void
  run: (options?: {
    focusId?: string
    retry?: 'intent' | 'answer' | 'relationships'
    fresh?: boolean
  }) => Promise<void>
  stop: () => void
  receive: (event: Envelope) => void
  nodesChange: (changes: NodeChange<PageNode>[]) => void
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
export const useStore = create<State>((set, get) => ({
  session: null,
  history: [],
  input: '',
  selected: null,
  selectedEdge: null,
  activeRequest: null,
  lastSeq: 0,
  stage: '',
  error: null,
  storageError: null,
  baseline: [],
  initialize: async () => {
    try {
      const history = await loadSessions()
      set({ history: history.map((s) => (s.status === 'running' ? { ...s, status: 'partial' } : s)) })
    } catch {
      set({ storageError: '브라우저 저장소를 사용할 수 없습니다.' })
    }
  },
  setInput: (input) => set({ input }),
  newSearch: () => {
    get().stop()
    set({
      session: null,
      selected: null,
      selectedEdge: null,
      input: '',
      error: null,
      stage: '',
    })
  },
  open: (id) => {
    get().stop()
    const session = get().history.find((s) => s.id === id)
    if (session)
      set({
        session,
        selected: null,
        selectedEdge: null,
        input: '',
        error: null,
        stage: '',
      })
  },
  remove: async (id) => {
    if (get().session?.id === id) get().newSearch()
    set((s) => ({ history: s.history.filter((h) => h.id !== id) }))
    try {
      await persistence
      await deleteSession(id)
    } catch {
      set({ storageError: '기록을 삭제하지 못했습니다.' })
    }
  },
  sample: (kind) => {
    get().stop()
    commit(makeSample(kind))
    set({ input: '', selected: null, selectedEdge: null, error: null, stage: '' })
  },
  select: (selected) => set({ selected, selectedEdge: null }),
  selectEdge: (selectedEdge) => set({ selectedEdge, selected: null }),
  stop: () => {
    const { activeRequest, session } = get()
    set({ activeRequest: null, stage: '' }) // Invalidate before aborting: queued events cannot mutate another view.
    controller?.abort()
    controller = undefined
    if (access && activeRequest)
      void fetch(`/api/jobs/${access.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${access.token}` },
      }).catch(() => {})
    access = undefined
    if (activeRequest && session) commit({ ...session, status: 'cancelled' })
  },
  run: async (options = {}) => {
    const before = get()
    if (before.activeRequest) return
    if (before.session?.mode === 'sample' && (options.focusId || options.retry)) return
    const query = options.focusId
      ? `${before.session?.query}\n선택한 페이지와 관련된 자료를 더 찾아줘.`
      : options.retry || options.fresh
        ? before.session?.query || before.input
        : before.input.trim()
    if (!query) return
    if (before.session?.clarification && !before.session.continuation && !options.fresh) {
      set({ error: '이어서 검색할 정보가 없습니다. 새로 조회해 주세요.' })
      return
    }
    const reusable = before.session?.mode === 'live' && before.session.continuation && !options.fresh
    const session = reusable ? { ...before.session! } : emptySession(query)
    session.status = 'running'
    session.updatedAt = Date.now()
    const requestId = crypto.randomUUID()
    const abort = new AbortController()
    controller = abort
    set({
      session,
      activeRequest: requestId,
      lastSeq: 0,
      stage: '검색 중',
      error: null,
      baseline: session.nodes,
      focusId: options.focusId,
      selectedEdge: null,
      input: '',
    })
    try {
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abort.signal,
        body: JSON.stringify({
          query,
          request_id: requestId,
          continuation: reusable ? session.continuation : undefined,
          focus_source_id: options.focusId,
          retry_part: options.retry,
        }),
      })
      await consumeSSE(response, get().receive, abort.signal)
    } catch (error) {
      if (get().activeRequest !== requestId || abort.signal.aborted) return
      set({ error: error instanceof Error ? error.message : '검색 중 오류가 발생했습니다.' })
      const current = get().session
      if (current) commit({ ...current, status: current.sources.length ? 'partial' : 'failed' })
    } finally {
      if (get().activeRequest === requestId) {
        set({ activeRequest: null, stage: '' })
        access = undefined
        controller = undefined
      }
    }
  },
  receive: (event) => {
    const state = get()
    if (event.request_id !== state.activeRequest || event.seq <= state.lastSeq || !state.session) return
    set({ lastSeq: event.seq })
    const session = { ...state.session }
    switch (event.type) {
      case 'started':
        access = { id: event.job_id, token: String(event.data.access_token) }
        break
      case 'status':
        set({
          stage:
            (
              {
                understanding: '질문 확인 중',
                searching: '검색 중',
                reading: '자료 확인 중',
                relating: '관련성 정리 중',
              } as Record<string, string>
            )[String(event.data.stage)] || '검색 중',
        })
        break
      case 'sources': {
        const sources = new Map(session.sources.map((s) => [s.id, s]))
        for (const source of event.data.sources as Source[]) sources.set(source.id, source)
        session.sources = [...sources.values()]
        session.nodes = layoutPages(session.sources, session.nodes, session.graph, state.focusId)
        set({ session })
        break
      }
      case 'answer':
        session.clarification = null
        session.answer = event.data as unknown as Answer
        session.failedParts = session.failedParts.filter((p) => p !== 'answer')
        set({ session })
        break
      case 'relationships': {
        const incoming = event.data as unknown as Graph
        const ids = new Set(session.sources.map((s) => s.id))
        // Defense in depth: no relation may reference a nonexistent card.
        session.graph = {
          ...incoming,
          relations: incoming.relations.filter((e) => ids.has(e.source) && ids.has(e.target)),
        }
        const fixed = session.nodes.filter(
          (n) => state.baseline.some((b) => b.id === n.id) || session.pinned.includes(n.id),
        )
        session.nodes = layoutPages(session.sources, fixed, session.graph, state.focusId)
        session.failedParts = session.failedParts.filter((p) => p !== 'relationships')
        set({ session })
        break
      }
      case 'part_error': {
        const failure = event.data as unknown as PartError
        session.failedParts = [...new Set([...session.failedParts, String(event.data.part)])]
        set({ session, error: failure.code ? `${failure.message} [${failure.code}]` : failure.message })
        break
      }
      case 'clarification':
        session.clarification = event.data as unknown as Clarification
        session.failedParts = session.failedParts.filter((p) => p !== 'intent')
        set({ session })
        break
      case 'checkpoint':
        session.continuation = String(event.data.continuation)
        set({ session })
        break
      case 'done':
        if (event.data.status === 'completed') session.clarification = null
        session.status = event.data.status as Session['status']
        commit(session)
        break
    }
  },
  nodesChange: (changes) => {
    const session = get().session
    if (!session) return
    const selection = changes.find((c) => c.type === 'select' && c.selected)
    if (selection && selection.type === 'select') set({ selected: selection.id, selectedEdge: null })
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
