import { useGraphArrival } from './hooks/useGraphArrival'
import { TooltipLayer } from './components/TooltipLayer'
import { nodeLabel, responseParentId } from './lib/nodeActions'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  Background,
  BackgroundVariant,
  MarkerType,
  PanOnScrollMode,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
  type Edge,
} from '@xyflow/react'
import {
  ArrowUp,
  ArrowLeft,
  ArrowRight,
  PanelLeftClose,
  ExternalLink,
  Maximize,
  Minus,
  Plus,
  MessageCircle,
  MessageCirclePlus,
  Square,
  Trash2,
  X,
  RotateCcw,
} from 'lucide-react'
import '@xyflow/react/dist/style.css'
import { useStore } from './store'
import { RabbitLoader } from './components/RabbitLoader'
import { RabbitIcon } from './components/RabbitIcon'
import { PageCard } from './components/PageCard'
import { ConversationEdge } from './components/ConversationEdge'
import { RelationEdge } from './components/RelationEdge'
import { AnswerPanel } from './components/AnswerPanel'
import { ResponseCard } from './components/ResponseCard'
import { ContentCard } from './components/ContentCard'
import { ContentEdge } from './components/ContentEdge'
import { Button } from './components/ui/button'
import { canvasBounds } from './lib/canvasBounds'
import { safeUrl } from './lib/utils'
import { CARD_HEIGHT, CARD_WIDTH } from './lib/layout'
import type { CanvasNode } from './types'

const nodeTypes = { page: PageCard, response: ResponseCard, information: ContentCard, source: ContentCard },
  edgeTypes = { relation: RelationEdge, conversation: ConversationEdge, content: ContentEdge }
function Workspace() {
  const state = useStore(),
    session = state.session
  const flow = useReactFlow<CanvasNode>(),
    viewport = useViewport()
  const [screenSize, setScreenSize] = useState({ width: window.innerWidth, height: window.innerHeight })
  useEffect(() => {
    const resize = () => setScreenSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  const extent = useMemo(
    () => canvasBounds(session?.nodes ?? [], viewport, screenSize),
    [session?.nodes, viewport, screenSize],
  )
  const [historyOpen, setHistoryOpen] = useState(() => window.innerWidth > 700)
  useEffect(() => {
    const mobile = window.matchMedia('(max-width: 700px)')
    const collapseOnMobile = () => {
      if (mobile.matches) setHistoryOpen(false)
    }
    mobile.addEventListener('change', collapseOnMobile)
    return () => mobile.removeEventListener('change', collapseOnMobile)
  }, [])
  const [weak, setWeak] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null),
    composing = useRef(false)
  useEffect(() => {
    if (state.replyTo) inputRef.current?.focus()
  }, [state.replyTo])
  const navigateRef = useRef<(direction: number) => void>(() => {})
  const fitRef = useRef<(initial?: boolean) => void>(() => {})
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey) return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable="true"]')
      )
        return
      const key = event.key.toLowerCase()
      const modified = event.ctrlKey || event.metaKey
      if (!modified) {
        if (event.shiftKey || !['KeyW', 'KeyS', 'KeyA', 'KeyD'].includes(event.code)) return
        event.preventDefault()
        if (event.code === 'KeyA' || event.code === 'KeyD') {
          if (!event.repeat) navigateRef.current(event.code === 'KeyA' ? -1 : 1)
          return
        }
        if (event.repeat) {
          const factor = event.code === 'KeyS' ? 1 / 1.04 : 1.04
          void flow.zoomTo(flow.getViewport().zoom * factor, { duration: 0 })
        } else if (event.code === 'KeyS') void flow.zoomOut({ duration: 150 })
        else void flow.zoomIn({ duration: 150 })
        return
      }
      if (event.repeat || !['b', '+', '=', '-', '0'].includes(key)) return
      event.preventDefault()
      if (key === 'b') setHistoryOpen((open) => !open)
      else if (key === '0') fitRef.current()
      else if (key === '-') void flow.zoomOut({ duration: 150 })
      else void flow.zoomIn({ duration: 150 })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [flow])
  useEffect(() => {
    void useStore.getState().initialize()
  }, [])
  useEffect(() => {
    const s = useStore.getState().session
    void flow.setViewport(s?.viewport ?? { x: 0, y: 0, zoom: 1 })
  }, [session?.id, flow])
  function fit(initial = false) {
    let nodes = useStore.getState().session?.nodes
    if (!nodes?.length) return
    if (initial && window.innerWidth < 700) nodes = nodes.slice(0, 1)
    const minX = Math.min(...nodes.map((n) => n.position.x)),
      minY = Math.min(...nodes.map((n) => n.position.y))
    const width = Math.max(...nodes.map((n) => n.position.x + (n.width ?? CARD_WIDTH))) - minX
    const height =
      Math.max(...nodes.map((n) => n.position.y + (n.measured?.height ?? n.height ?? CARD_HEIGHT))) - minY
    const mobile = window.innerWidth < 700
    const left = mobile ? 24 : historyOpen ? 250 : 75
    const right = mobile ? 24 : 34
    const top = mobile ? (session?.protocol === 2 ? 145 : 170) : session?.answer ? 240 : 120,
      bottom = mobile ? (session?.protocol === 2 ? 180 : 280) : 150
    const roomW = Math.max(220, window.innerWidth - left - right),
      roomH = Math.max(200, window.innerHeight - top - bottom)
    const padding = session?.protocol === 2 ? 16 : 60
    const zoom = Math.min(0.95, roomW / (width + padding), roomH / (height + padding))
    const next = {
      x: left + roomW / 2 - (minX + width / 2) * zoom,
      y: top + roomH / 2 - (minY + height / 2) * zoom,
      zoom,
    }
    void flow.setViewport(next, { duration: initial ? 0 : 250 })
    state.viewport(next)
    state.markFitted()
  }
  function focusNode(node: CanvasNode) {
    const zoom = flow.getViewport().zoom
    const width = node.measured?.width ?? node.width ?? CARD_WIDTH
    const height = node.measured?.height ?? node.height ?? CARD_HEIGHT
    const mobile = window.innerWidth < 700
    const left = mobile ? 24 : historyOpen ? 250 : 75
    const right = mobile ? 24 : 70
    const top = mobile ? 145 : 120
    const bottom = 160
    const roomHeight = Math.max(100, window.innerHeight - top - bottom)
    // Keep the heading visible when a long response is taller than the viewport.
    const next = {
      x: left + (window.innerWidth - left - right) / 2 - (node.position.x + width / 2) * zoom,
      y: top + roomHeight / 2 - node.position.y * zoom - Math.min(height * zoom, roomHeight) / 2,
      zoom,
    }
    state.markFitted()
    void flow.setViewport(next, {
      duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 250,
    })
  }
  const navigationIndex = Math.max(0, session?.nodes.findIndex((node) => node.id === state.selected) ?? 0)
  function navigateNode(direction: number) {
    const current = useStore.getState()
    const ordered = current.session?.nodes ?? []
    const index = Math.max(
      0,
      ordered.findIndex((node) => node.id === current.selected),
    )
    const next = ordered[index + direction]
    if (!next) return
    current.select(next.id)
    focusNode(next)
  }
  useEffect(() => {
    const node = useStore.getState().session?.nodes.find((n) => n.id === state.navigation?.id)
    if (node) focusNode(node)
  }, [state.navigation])
  navigateRef.current = navigateNode
  fitRef.current = fit
  useEffect(() => {
    if (
      session?.nodes.length &&
      !session.fitted &&
      (session.protocol === 2 || session.status !== 'running')
    ) {
      const timer = window.setTimeout(() => fitRef.current(true), 80)
      return () => clearTimeout(timer)
    }
  }, [session?.id, session?.nodes.length, session?.fitted, session?.status])
  const related = useMemo(
    () =>
      new Set(
        session?.graph.relations.flatMap((e) =>
          e.source === state.selected ? [e.target] : e.target === state.selected ? [e.source] : [],
        ) ?? [],
      ),
    [session?.graph, state.selected],
  )
  const nodes = useMemo(
    () =>
      session?.nodes.map((n): CanvasNode =>
        n.type !== 'page'
          ? { ...n, selected: n.id === state.selected }
          : {
              ...n,
              selected: n.id === state.selected,
              data: {
                ...n.data,
                related: related.has(n.id),
                dimmed: Boolean(state.selected && n.id !== state.selected && !related.has(n.id)),
              },
            },
      ) ?? [],
    [session?.nodes, related, state.selected],
  )
  const edges: Edge[] = useMemo(() => {
    if (session?.protocol === 2) {
      const responses = session.nodes.filter((n) => n.type === 'response')
      const conversationEdges: Edge[] = responses.flatMap((node) => {
        const parentId = responseParentId(session, node)
        if (!parentId || !session.nodes.some((n) => n.id === parentId)) return []
        return [
          {
            id: `conversation-${parentId}-${node.id}`,
            source: parentId,
            target: node.id,
            type: 'conversation',
            className: 'conversation-edge',
            ariaLabel: '이전 노드에서 이어진 응답',
            selectable: false,
            focusable: false,
            markerEnd: { type: MarkerType.ArrowClosed, color: '#7fa99c', width: 16, height: 16 },
            style: { stroke: '#7fa99c', strokeWidth: 1.5 },
          },
        ]
      })
      const contentEdges: Edge[] = (session.contentGraph?.relations ?? []).filter((edge) => {
        // The forward conversation edge already displays this explicit selection.
        const response = responses.find((n) => n.id === edge.source)
        return !(edge.kind === 'uses_context' && response && responseParentId(session, response) === edge.target)
      }).map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'content',
        label: { has_extract: '정보 추출', consulted: '조회', cites: '출처 표기', uses_context: '맥락 참고' }[edge.kind],
        ariaLabel: {
          has_extract: '응답에서 정보 추출',
          consulted: '응답에서 자료 조회',
          cites: '원문에 출처 표기',
          uses_context: '새 응답에서 선택한 노드를 맥락으로 참고',
        }[edge.kind],
        markerEnd: { type: MarkerType.ArrowClosed, color: '#91a69d', width: 14, height: 14 },
        style: {
          stroke: edge.kind === 'has_extract' ? '#bcab82' : '#91a69d',
          strokeDasharray: edge.kind === 'consulted' ? '4 4' : undefined,
        },
        selectable: false,
      }))
      return [...conversationEdges, ...contentEdges]
    }
    return (
      session?.graph.relations.map((e, i) => ({
        id: `edge-${i}`,
        source: e.source,
        target: e.target,
        type: 'relation',
        markerEnd: { type: MarkerType.ArrowClosed, color: '#94b2a6', width: 16, height: 16 },
        label: e.label,
        hidden: e.strength === 'weak' && !weak,
        style: {
          stroke:
            e.source === state.selected || e.target === state.selected || state.selectedEdge === i
              ? '#0F766E'
              : '#becbc6',
          strokeWidth: state.selectedEdge === i ? 2.4 : 1.35,
          opacity: state.selected && e.source !== state.selected && e.target !== state.selected ? 0.3 : 1,
          strokeDasharray: e.strength === 'weak' ? '4 5' : undefined,
        },
      })) ?? []
    )
  }, [
    session?.graph,
    session?.contentGraph,
    session?.nodes,
    session?.protocol,
    state.selected,
    state.selectedEdge,
    weak,
  ])
  const arrivingGraph = useGraphArrival(session?.id, nodes, edges)
  const selectedSource = session?.sources.find((s) => s.id === state.selected)
  const selectedRelation =
    state.selectedEdge === null ? undefined : session?.graph.relations[state.selectedEdge]
  const busy = Boolean(state.activeRequest)
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!composing.current && !busy) void state.run()
  }
  return (
    <main
      className={`workspace ${historyOpen ? 'sidebar-open' : 'sidebar-closed'} ${session ? 'has-session' : 'is-empty'}`}
      aria-label="대화 캔버스"
    >
      <ReactFlow<CanvasNode>
        translateExtent={extent}
        nodes={arrivingGraph.nodes}
        edges={arrivingGraph.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={state.nodesChange}
        onNodeClick={(event, node) => {
          const target = event.target
          if (target instanceof Element && target.closest('button, a, input, textarea')) return
          state.select(node.id)
          focusNode(node)
        }}
        onNodeDragStop={(_, node) => {
          state.nodesChange([{ type: 'position', id: node.id, position: node.position, dragging: false }])
          state.markFitted()
        }}
        onPaneClick={() => {
          state.select(null)
          state.selectEdge(null)
        }}
        onMoveEnd={(event, v) => {
          state.viewport(v)
          if (event) state.markFitted()
        }}
        onWheelCapture={(event) => {
          if (!event.shiftKey || event.ctrlKey || event.metaKey) return
          const target = event.target
          if (target instanceof Element && target.closest('.nowheel')) return
          event.preventDefault()
          event.stopPropagation()
          const current = flow.getViewport()
          const unit = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? window.innerWidth : 1
          void flow.setViewport({ ...current, x: current.x - (event.deltaX || event.deltaY) * unit * 0.5 })
          state.markFitted()
        }}
        panOnScroll
        panOnScrollMode={PanOnScrollMode.Free}
        zoomOnScroll={false}
        zoomActivationKeyCode="Control"
        zoomOnDoubleClick={false}
        minZoom={0.15}
        maxZoom={1.75}
        nodesConnectable={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        aria-label="페이지 관계 캔버스"
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Lines} gap={28} lineWidth={0.6} color="#e2e6df" />
      </ReactFlow>
      {Boolean(session?.nodes.length) && (
        <nav className="node-navigation panel" aria-label="노드 탐색">
          <Button
            variant="ghost"
            size="icon"
            aria-label="이전 노드"
            data-tooltip="이전 노드 · A"
            data-tooltip-position="bottom"
            aria-keyshortcuts="a"
            disabled={navigationIndex === 0}
            onClick={() => navigateNode(-1)}
          >
            <ArrowLeft size={16} />
          </Button>
          <span aria-live="polite" aria-atomic="true">
            {navigationIndex + 1}/{session!.nodes.length}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="다음 노드"
            data-tooltip="다음 노드 · D"
            data-tooltip-position="bottom"
            aria-keyshortcuts="d"
            disabled={navigationIndex >= session!.nodes.length - 1}
            onClick={() => navigateNode(1)}
          >
            <ArrowRight size={16} />
          </Button>
        </nav>
      )}
      <header className="sidebar-header">
        <button
          className="brand"
          aria-label={historyOpen ? 'Rabbit Hole' : '대화 기록 펼치기'}
          aria-expanded={historyOpen}
          data-tooltip={historyOpen ? '초기 화면으로' : '대화 기록 펼치기 · Ctrl/⌘+B'}
          aria-keyshortcuts="Control+b Meta+b"
          data-tooltip-position="bottom"
          onClick={() => {
            if (!historyOpen) {
              setHistoryOpen(true)
            } else {
              state.newConversation()
              if (window.innerWidth < 700) setHistoryOpen(false)
              inputRef.current?.focus()
            }
          }}
        >
          <RabbitIcon />
          <span>Rabbit Hole</span>
        </button>
        <Button
          className="sidebar-collapse"
          variant="ghost"
          size="icon"
          aria-label="대화 기록 접기"
          data-tooltip="대화 기록 접기 · Ctrl/⌘+B"
          aria-keyshortcuts="Control+b Meta+b"
          data-tooltip-position="bottom"
          aria-expanded={historyOpen}
          aria-hidden={!historyOpen}
          tabIndex={historyOpen ? 0 : -1}
          onClick={() => setHistoryOpen(false)}
        >
          <PanelLeftClose size={18} />
        </Button>
      </header>
      <aside
        className="history-panel panel"
        aria-label="대화 기록"
        aria-hidden={!historyOpen}
        inert={!historyOpen}
      >
        <Button
          className="new-search"
          onClick={() => {
            state.newConversation()
            if (window.innerWidth < 700) setHistoryOpen(false)
            inputRef.current?.focus()
          }}
        >
          <Plus />새 대화
        </Button>
        <h2>
          최근 대화 <span>{state.history.length}</span>
        </h2>
        <div className="history-list">
          {!state.history.length && <p className="history-empty">대화 기록이 없습니다</p>}
          {state.history.map((h) => (
            <div className={`history-row ${session?.id === h.id ? 'active' : ''}`} key={h.id}>
              <button
                className="history-item"
                onClick={() => {
                  state.open(h.id)
                  if (window.innerWidth < 700) setHistoryOpen(false)
                }}
              >
                <span>{h.title || h.query}</span>
                {h.mode === 'sample' && <small>예시</small>}
              </button>
              <button
                className="history-delete"
                aria-label={`${h.title || h.query} 기록 삭제`}
                onClick={() => void state.remove(h.id)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      </aside>
      {session && (
        <div className="canvas-heading">
          <div>
            <h1>{(session.title || session.query).split('\n')[0]}</h1>
          </div>
          <span>
            {session.protocol === 2
              ? `${session.nodes.filter((n) => n.type === 'response').length}개의 응답 · ${session.nodes.filter((n) => n.type === 'information').length}개 정보 · ${session.nodes.filter((n) => n.type === 'source').length}개 출처`
              : `${session.sources.length}개의 페이지`}
          </span>
          {session.mode === 'sample' && <span className="sample-badge">이전 가상 데이터 기록</span>}
        </div>
      )}
      {session?.protocol !== 2 && <AnswerPanel />}
      {(selectedSource || selectedRelation) && (
        <section className="detail-panel panel" aria-label={selectedSource ? '출처 상세' : '관계 상세'}>
          <header>
            <span>{selectedSource ? '페이지 자세히 보기' : '왜 연결되었나요?'}</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="상세 닫기"
              onClick={() => {
                state.select(null)
                state.selectEdge(null)
              }}
            >
              <X />
            </Button>
          </header>
          <div className="detail-body">
            {selectedSource ? (
              <>
                <small>{selectedSource.domain}</small>
                <h2>{selectedSource.title}</h2>
                <span className="tag">
                  {selectedSource.content_origin === 'web_search_summary'
                    ? 'AI 생성 요약 · 원문 미확인'
                    : selectedSource.read_status === 'read'
                      ? '원문 확인 기반'
                      : '자료 요약 기반 · 원문 미확인'}
                </span>
                <blockquote>
                  {selectedSource.excerpt || selectedSource.summary || '확보한 발췌가 없습니다.'}
                </blockquote>
                {selectedSource.retrieved_at && (
                  <p className="timestamp">
                    조회 {new Date(selectedSource.retrieved_at).toLocaleString('ko-KR')}
                  </p>
                )}
                {selectedSource.published_at && (
                  <p className="timestamp">게시 {selectedSource.published_at}</p>
                )}
                {safeUrl(selectedSource.url) && (
                  <a
                    className="source-link"
                    href={safeUrl(selectedSource.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    원문 열기
                    <ExternalLink size={14} />
                  </a>
                )}
                {session?.mode === 'sample' && <p className="timestamp">이전 가상 데이터 기록입니다.</p>}
              </>
            ) : (
              selectedRelation && (
                <>
                  <h2>{selectedRelation.label}</h2>
                  <p>{selectedRelation.explanation}</p>
                  {selectedRelation.evidence.map((e, i) => (
                    <div className="evidence" key={i}>
                      <button onClick={() => state.select(e.source_id)}>
                        {session?.sources.find((s) => s.id === e.source_id)?.domain}
                      </button>
                      <blockquote>{e.quote}</blockquote>
                      <small>
                        {session?.sources.find((s) => s.id === e.source_id)?.content_origin ===
                        'web_search_summary'
                          ? 'AI 생성 요약 · 원문 미확인'
                          : e.basis === 'excerpt'
                            ? '원문 확인 기반'
                            : '자료 요약 기반'}
                      </small>
                    </div>
                  ))}
                  <p className="timestamp">연결은 내용의 관련성이며 사실의 신뢰도를 뜻하지 않습니다.</p>
                </>
              )
            )}
          </div>
        </section>
      )}
      <div className="composer-area">
        {(state.error || state.storageError) && (
          <div className="error-banner panel" role="alert">
            <span>{state.error || state.storageError}</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="오류 안내 닫기"
              onClick={() => useStore.setState({ error: null, storageError: null })}
            >
              <X />
            </Button>

            {!busy && session?.status === 'failed' && (
              <Button variant="outline" size="sm" onClick={() => void state.run({ retry: true })}>
                다시 시도
              </Button>
            )}
          </div>
        )}
        {busy && (
          <div className="agent-status" role="status">
            <RabbitLoader />
            {state.stage}
            <span>받은 응답부터 캔버스에 표시합니다.</span>
          </div>
        )}
        {!busy && session && session.mode === 'live' && session.protocol === 2 && (
          <div className="result-status">
            <span>
              {
                {
                  completed: '대화를 이어가 보세요',
                  awaiting_input: '추가 답변을 기다리고 있어요',
                  partial: '부분 완료 · 확보한 결과 유지',
                  failed: '요청을 완료하지 못했어요',
                  cancelled: '응답 중지 · 확보한 결과 유지',
                  idle: '',
                  running: '',
                }[session.status]
              }
            </span>
            {['failed', 'partial', 'cancelled'].includes(session.status) && (
              <button onClick={() => void state.run({ retry: true })}>
                <RotateCcw size={12} />
                다시 요청
              </button>
            )}
          </div>
        )}
        {!session && (
          <section className="welcome">
            <div className="welcome-brand"><RabbitIcon /><span>Rabbit Hole</span></div>
            <h1>호기심이 이어지는 곳</h1>
          </section>
        )}
        <form className={`composer panel ${state.replyTo ? 'has-reply' : ''}`} onSubmit={submit}>
          {state.replyTo && (
            <div className="reply-slot">
              <div className="reply-context" aria-label="이어서 질문할 응답">
                <MessageCirclePlus size={15} aria-hidden="true" />
                <div className="reply-context-text">
                  <strong>이어서 질문하기</strong>
                  <span>
                    {
                      nodeLabel(session ?? null, state.replyTo)
                    }
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => state.reply(null)}
                  aria-label="이어서 질문 취소"
                  data-tooltip="이어서 질문 취소"
                >
                  <X size={15} />
                </button>
              </div>
            </div>
          )}
          <MessageCircle size={21} />
          <textarea
            ref={inputRef}
            rows={1}
            aria-label="메시지 입력"
            placeholder={
              session?.protocol === 2 ? '이어서 질문하거나 다음 작업을 요청하세요' : '무엇이 궁금한가요?'
            }
            value={state.input}
            maxLength={2000}
            onChange={(e) => state.setInput(e.target.value)}
            onCompositionStart={() => {
              composing.current = true
            }}
            onCompositionEnd={() => {
              composing.current = false
            }}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                !composing.current &&
                e.keyCode !== 229
              ) {
                e.preventDefault()
                if (!busy) void state.run()
              }
            }}
          />
          {busy ? (
            <Button type="button" size="icon" aria-label="응답 중지" onClick={state.stop}>
              <Square size={15} />
            </Button>
          ) : (
            <Button type="submit" size="icon" aria-label="메시지 보내기" disabled={!state.input.trim()}>
              <ArrowUp />
            </Button>
          )}
        </form>
        {session?.mode === 'sample' && (
          <p className="composer-note">
            이전 가상 데이터 기록입니다. 메시지를 보내면 새로운 대화를 시작합니다.
          </p>
        )}
      </div>
      {session?.sources.length ? (
        <div className="map-legend">
          <span />
          <span>페이지 사이의 내용 관계</span>
          {session.graph.relations.some((e) => e.strength === 'weak') && (
            <label>
              <input type="checkbox" checked={weak} onChange={(e) => setWeak(e.target.checked)} />
              약한 연결
            </label>
          )}
        </div>
      ) : null}
      <nav className="canvas-tools panel" aria-label="캔버스 도구">
        <Button
          variant="ghost"
          size="icon"
          aria-label="화면 맞춤"
          data-tooltip="화면 맞춤 · Ctrl/⌘+0"
          aria-keyshortcuts="Control+0 Meta+0"
          onClick={() => fit()}
        >
          <Maximize />
        </Button>
        <i />
        <Button
          variant="ghost"
          size="icon"
          aria-label="축소"
          data-tooltip="축소 · S · Ctrl/⌘+− · Ctrl+휠 아래"
          aria-keyshortcuts="s Control+- Meta+-"
          onClick={() => void flow.zoomOut({ duration: 150 })}
        >
          <Minus />
        </Button>
        <span
          aria-label="현재 배율"
          data-tooltip="휠: 상하 · Shift+휠: 좌우 · 트랙패드: 자유 이동 · Ctrl+휠: 확대·축소"
        >
          {Math.round(viewport.zoom * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="확대"
          data-tooltip="확대 · W · Ctrl/⌘++ · Ctrl+휠 위"
          aria-keyshortcuts="w Control++ Meta++"
          onClick={() => void flow.zoomIn({ duration: 150 })}
        >
          <Plus />
        </Button>
      </nav>
    </main>
  )
}
export default function App() {
  return (
    <ReactFlowProvider>
      <Workspace />
      <TooltipLayer />
    </ReactFlowProvider>
  )
}
