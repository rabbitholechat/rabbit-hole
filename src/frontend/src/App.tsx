import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  Background,
  BackgroundVariant,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
  type Edge,
} from '@xyflow/react'
import {
  ArrowUp,
  PanelLeftClose,
  ChevronRight,
  Clock3,
  ExternalLink,
  Maximize,
  Minus,
  Plus,
  MessageCircle,
  Square,
  Trash2,
  X,
  FlaskConical,
  RotateCcw,
  LoaderCircle,
  Compass,
} from 'lucide-react'
import '@xyflow/react/dist/style.css'
import { useStore } from './store'
import { RabbitIcon } from './components/RabbitIcon'
import { PageCard } from './components/PageCard'
import { RelationEdge } from './components/RelationEdge'
import { AnswerPanel } from './components/AnswerPanel'
import { ClarificationPanel } from './components/ClarificationPanel'
import { Button } from './components/ui/button'
import { safeUrl } from './lib/utils'
import { CARD_HEIGHT, CARD_WIDTH } from './lib/layout'
import type { PageNode } from './types'

const nodeTypes = { page: PageCard },
  edgeTypes = { relation: RelationEdge }
const sampleTitles = ['벡터 검색이란?', '아이폰 폴드 가격과 출시일', '오사카 최저가 항공권']
const suggestions = [
  '복잡한 개념을 쉽게 설명해줘',
  '두 가지 선택지를 비교해줘',
  '아이디어를 실행 계획으로 정리해줘',
]
function Workspace() {
  const state = useStore(),
    session = state.session
  const flow = useReactFlow<PageNode>(),
    viewport = useViewport()
  const [historyOpen, setHistoryOpen] = useState(() => window.innerWidth > 700)
  useEffect(() => {
    const mobile = window.matchMedia('(max-width: 700px)')
    const collapseOnMobile = () => {
      if (mobile.matches) setHistoryOpen(false)
    }
    mobile.addEventListener('change', collapseOnMobile)
    return () => mobile.removeEventListener('change', collapseOnMobile)
  }, [])
  const [samplesOpen, setSamplesOpen] = useState(false)
  const [weak, setWeak] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null),
    composing = useRef(false)
  const fitRef = useRef<(initial?: boolean) => void>(() => {})
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
    const width = Math.max(...nodes.map((n) => n.position.x + CARD_WIDTH)) - minX
    const height = Math.max(...nodes.map((n) => n.position.y + CARD_HEIGHT)) - minY
    const mobile = window.innerWidth < 700
    const left = mobile ? 24 : historyOpen ? 250 : 75
    const right = mobile ? 24 : 34
    const top = mobile ? 170 : session?.answer ? 240 : 120,
      bottom = mobile ? 280 : 150
    const roomW = Math.max(220, window.innerWidth - left - right),
      roomH = Math.max(200, window.innerHeight - top - bottom)
    const zoom = Math.min(0.95, roomW / (width + 60), roomH / (height + 60))
    const next = {
      x: left + roomW / 2 - (minX + width / 2) * zoom,
      y: top + roomH / 2 - (minY + height / 2) * zoom,
      zoom,
    }
    void flow.setViewport(next, { duration: initial ? 0 : 250 })
    state.viewport(next)
    state.markFitted()
  }
  fitRef.current = fit
  useEffect(() => {
    if (session?.nodes.length && !session.fitted && session.status !== 'running') {
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
      session?.nodes.map((n) => ({
        ...n,
        selected: n.id === state.selected,
        data: {
          ...n.data,
          related: related.has(n.id),
          dimmed: Boolean(state.selected && n.id !== state.selected && !related.has(n.id)),
        },
      })) ?? [],
    [session?.nodes, related, state.selected],
  )
  const edges: Edge[] = useMemo(
    () =>
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
      })) ?? [],
    [session?.graph, state.selected, state.selectedEdge, weak],
  )
  const selectedSource = session?.sources.find((s) => s.id === state.selected)
  const selectedRelation =
    state.selectedEdge === null ? undefined : session?.graph.relations[state.selectedEdge]
  const busy = Boolean(state.activeRequest)
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!composing.current && !busy) void state.run()
  }
  function fill(query: string) {
    state.setInput(query)
    inputRef.current?.focus()
  }
  return (
    <main
      className={`workspace ${historyOpen ? 'sidebar-open' : 'sidebar-closed'} ${session ? 'has-session' : 'is-empty'}`}
      aria-label="대화 캔버스"
    >
      <ReactFlow<PageNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={state.nodesChange}
        onNodeClick={(_, node) => state.select(node.id)}
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
      <header className="sidebar-header">
        <button
          className="brand"
          aria-label={historyOpen ? 'Rabbit Hole' : '대화 기록 펼치기'}
          aria-expanded={historyOpen}
          data-tooltip={historyOpen ? undefined : '대화 기록 펼치기'}
          data-tooltip-position="bottom"
          onClick={() => {
            if (!historyOpen) setHistoryOpen(true)
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
          data-tooltip="대화 기록 접기"
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
            state.newSearch()
            if (window.innerWidth < 700) setHistoryOpen(false)
            inputRef.current?.focus()
          }}
        >
          <Plus />새 대화
        </Button>
        <h2>
          최근 대화 <span>{state.history.length || ''}</span>
        </h2>
        <div className="history-list">
          {!state.history.length && <p className="history-empty">대화 기록이 여기에 쌓입니다.</p>}
          {state.history.map((h) => (
            <div className={`history-row ${session?.id === h.id ? 'active' : ''}`} key={h.id}>
              <button
                className="history-item"
                onClick={() => {
                  state.open(h.id)
                  if (window.innerWidth < 700) setHistoryOpen(false)
                }}
              >
                <Clock3 size={14} />
                <span>{h.query}</span>
                {h.mode === 'sample' && <small>예시</small>}
              </button>
              <button
                className="history-delete"
                aria-label={`${h.query} 기록 삭제`}
                onClick={() => void state.remove(h.id)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <div className="sample-controls">
          <button onClick={() => setSamplesOpen(!samplesOpen)} aria-expanded={samplesOpen}>
            <FlaskConical size={13} />
            디자인 예시 둘러보기
            <ChevronRight size={12} />
          </button>
          {samplesOpen && (
            <div className="sample-menu">
              {(['vector', 'fold', 'flight'] as const).map((kind, i) => (
                <button
                  key={kind}
                  onClick={() => {
                    state.sample(kind)
                    if (window.innerWidth < 700) setHistoryOpen(false)
                  }}
                >
                  {sampleTitles[i]}
                  <span>가상 데이터</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>
      {session && (
        <div className="canvas-heading">
          <div>
            <span className="eyebrow">
              {session.mode === 'sample' ? 'DESIGN PREVIEW' : 'YOUR EXPLORATION'}
            </span>
            <h1>{session.query.split('\n')[0]}</h1>
          </div>
          <span>{session.sources.length}개의 페이지</span>
          {session.mode === 'sample' && <span className="sample-badge">디자인 예시 · 가상 데이터</span>}
        </div>
      )}
      <AnswerPanel />
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
                <Button
                  className="explore-button"
                  variant="outline"
                  size="sm"
                  disabled={busy || session?.mode === 'sample' || !session?.continuation}
                  onClick={() => void state.run({ focusId: selectedSource.id })}
                >
                  <Compass />
                  관련 자료 더 찾기
                </Button>
                {session?.mode === 'sample' && (
                  <p className="timestamp">디자인 예시에서는 실제 요청을 실행하지 않습니다.</p>
                )}
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
        {!busy && session?.clarification && <ClarificationPanel clarification={session.clarification} />}
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
              <Button variant="outline" size="sm" onClick={() => void state.run({ fresh: true })}>
                다시 시도
              </Button>
            )}
          </div>
        )}
        {busy && (
          <div className="search-status" role="status">
            <LoaderCircle className="spin" size={14} />
            {state.stage}
            <span>확보한 자료부터 보여드릴게요.</span>
          </div>
        )}
        {!busy && session && session.mode === 'live' && (
          <div className="result-status">
            <span>
              {
                {
                  completed: '탐색을 이어가 보세요',
                  awaiting_input: '추가 답변을 기다리고 있어요',
                  partial: '부분 완료 · 확보한 결과 유지',
                  failed: '요청을 완료하지 못했어요',
                  cancelled: '응답 중지 · 확보한 결과 유지',
                  idle: '',
                  running: '',
                }[session.status]
              }
            </span>
            <button onClick={() => void state.run({ fresh: true })}>
              <RotateCcw size={12} />
              다시 요청
            </button>
            {session.failedParts
              .filter((p) => p === 'intent' || p === 'answer' || p === 'relationships')
              .map((part) => (
                <Button
                  key={part}
                  size="sm"
                  variant="outline"
                  disabled={!session.continuation}
                  onClick={() => void state.run({ retry: part as 'intent' | 'answer' | 'relationships' })}
                >
                  {part === 'intent' ? '질문 확인' : part === 'answer' ? '답변' : '관계'} 재시도
                </Button>
              ))}
          </div>
        )}
        {!session && (
          <section className="welcome">
            <h1>호기심이 이어지는 곳</h1>
            <p>질문에서 아이디어로, 대화에서 다음 단계로.</p>
          </section>
        )}
        <form className="composer panel" onSubmit={submit}>
          <MessageCircle size={21} />
          <textarea
            ref={inputRef}
            rows={1}
            aria-label="메시지 입력"
            placeholder={
              session?.clarification
                ? '추가 질문에 답변해 주세요'
                : session
                  ? '이어서 질문하거나 다음 작업을 요청하세요'
                  : '무엇을 함께 풀어볼까요?'
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
        {!session && (
          <div className="suggestions">
            {suggestions.map((q) => (
              <button key={q} onClick={() => fill(q)}>
                {q}
                <ChevronRight size={13} />
              </button>
            ))}
          </div>
        )}
        <p className="composer-note">
          {session?.mode === 'sample'
            ? '디자인 예시입니다. 메시지를 보내면 새로운 대화를 시작합니다.'
            : '질문에서 아이디어로, 대화에서 다음 단계로.'}
        </p>
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
          data-tooltip="화면 맞춤"
          onClick={() => fit()}
        >
          <Maximize />
        </Button>
        <i />
        <Button
          variant="ghost"
          size="icon"
          aria-label="축소"
          data-tooltip="축소"
          onClick={() => void flow.zoomOut({ duration: 150 })}
        >
          <Minus />
        </Button>
        <span aria-label="현재 배율">{Math.round(viewport.zoom * 100)}%</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="확대"
          data-tooltip="확대"
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
    </ReactFlowProvider>
  )
}
