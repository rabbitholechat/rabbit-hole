import { SidebarSettings, LandingPlaceholder } from './components/SettingsDialog'
import { WelcomeNode, WelcomeExampleEdge, welcomeGraph, type WelcomeCanvasNode } from './components/WelcomeNode'
import { CanvasShareActions } from './components/CanvasShareActions'
import { SharedCanvasPage } from './components/SharedCanvasPage'
import { UserCard } from './components/UserCard'
import { ActionToast } from './components/ActionToast'
import { editLocked, visibleNodes, visibleLinks, defaultConnectionLabel } from './lib/canvasEditing'
import { useAutosizeTextarea } from './hooks/useAutosizeTextarea'
import { useGraphArrival } from './hooks/useGraphArrival'
import { TooltipLayer } from './components/TooltipLayer'
import { nodeLabel, responseParentId } from './lib/nodeActions'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type CSSProperties } from 'react'
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
  Undo2,
  Redo2,
  ArrowUp,
  ArrowLeft,
  ArrowRight,
  PanelLeftClose,
  ExternalLink,
  Maximize,
  Minus,
  Plus,
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
import { HistoryLoading } from './components/HistoryLoading'
import { ServerErrorPage } from './components/ServerErrorPage'
import { ErrorToast } from './components/ErrorToast'
import { PageCard } from './components/PageCard'
import { ConversationEdge } from './components/ConversationEdge'
import { RelationEdge } from './components/RelationEdge'
import { AnswerPanel } from './components/AnswerPanel'
import { ResponseCard } from './components/ResponseCard'
import { ResponseTimer } from './components/ResponseTimer'
import { ContentCard } from './components/ContentCard'
import { EntityCard } from './components/EntityCard'
import { ContentEdge } from './components/ContentEdge'
import { AttachmentCard } from './components/AttachmentCard'
import { AttachmentTray } from './components/AttachmentTray'
import { ComposerTools } from './components/ComposerTools'
import { Button } from './components/ui/button'
import { NODE_ACCENTS, nodeAccent } from './lib/nodeAppearance'
import { canvasBounds } from './lib/canvasBounds'
import { safeUrl } from './lib/utils'
import { CARD_HEIGHT, CARD_WIDTH } from './lib/layout'
import type { CanvasNode } from './types'

type WorkspaceNode = CanvasNode | WelcomeCanvasNode

const nodeTypes = { welcome: WelcomeNode, user: UserCard, attachment: AttachmentCard, page: PageCard, response: ResponseCard, information: ContentCard, source: ContentCard, entity: EntityCard },
  edgeTypes = { welcomeExample: WelcomeExampleEdge, relation: RelationEdge, conversation: ConversationEdge, content: ContentEdge }
function Workspace({ shared = false }: { shared?: boolean }) {
  const state = useStore(),
    session = state.session
  const [menu, setMenu] = useState<{ x: number; y: number; node?: string; edge?: string } | null>(null)
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape) }
  }, [menu])
  useEffect(() => setMenu(null), [session?.id, state.loadingSessionId])
  const dismissError = useCallback(() => useStore.setState({ error: null, storageError: null }), [])
  const flow = useReactFlow<WorkspaceNode>(),
    viewport = useViewport()
  const [screenSize, setScreenSize] = useState({ width: window.innerWidth, height: window.innerHeight })
  useEffect(() => {
    const resize = () => setScreenSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  const [historyOpen, setHistoryOpen] = useState(() => !shared && window.innerWidth > 700)
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
  useEffect(() => {
    if (state.draftAttachments.length) inputRef.current?.focus()
  }, [state.draftAttachments.length])
  const useExample = useCallback((prompt: string) => {
    useStore.getState().setInput(prompt)
    inputRef.current?.focus({ preventScroll: true })
  }, [])
  const welcome = useMemo(() => welcomeGraph(screenSize.width, useExample), [screenSize.width, useExample])
  const welcomeViewport = useMemo(() => {
    const mobile = screenSize.width <= 700
    const left = mobile ? 14 : shared ? 76 : 264
    const right = mobile ? 14 : screenSize.width <= 1100 ? 20 : 24
    return { x: (left + screenSize.width - right) / 2, y: screenSize.height / 2, zoom: 1 }
  }, [screenSize, shared])
  const extent = useMemo(
    () => canvasBounds(session ? visibleNodes(session) : welcome.nodes, session ? viewport : welcomeViewport, screenSize),
    [session, welcome, viewport, welcomeViewport, screenSize],
  )
  const navigateRef = useRef<(direction: number) => void>(() => {})
  const fitRef = useRef<(initial?: boolean) => void>(() => {})
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey || useStore.getState().serverError || useStore.getState().loadingSessionId) return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable="true"], dialog[open]')
      )
        return
      const key = event.key.toLowerCase()
      const modified = event.ctrlKey || event.metaKey
      const current = useStore.getState()
      if (current.editingNode || current.editingEdge) return
      if (modified && ['c', 'v', 'z', 'y'].includes(key) || key === 'delete' || key === 'backspace' && modified || key === 'f2' || modified && key === 'e') {
        event.preventDefault()
        if (event.repeat || !current.session) return
        if (modified && key === 'c' && current.selected) current.copyNode(current.selected)
        else if (modified && key === 'v') current.pasteNode(flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }), flow.getViewport())
        else if (modified && key === 'z') event.shiftKey ? current.redo() : current.undo()
        else if (modified && key === 'y') current.redo()
        else if (key === 'delete' || key === 'backspace') { if (current.selected) current.deleteNode(current.selected); else if (current.selectedLink) current.deleteEdge(current.selectedLink) }
        else if (key === 'f2' || key === 'e') { if (current.selected) current.editNode(current.selected); else if (current.selectedLink) current.editEdge(current.selectedLink) }
        return
      }
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
      if (key === 'b') { if (!shared) setHistoryOpen((open) => !open) }
      else if (key === '0') fitRef.current()
      else if (key === '-') void flow.zoomOut({ duration: 150 })
      else void flow.zoomIn({ duration: 150 })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [flow, shared])
  useEffect(() => {
    if (!shared) void useStore.getState().initialize()
  }, [shared])
  useEffect(() => {
    const s = useStore.getState().session
    if (s) void flow.setViewport(s.viewport)
  }, [session?.id, flow])
  useEffect(() => {
    if (!session) void flow.setViewport(welcomeViewport)
  }, [session?.id, flow, welcomeViewport])
  function fit(initial = false) {
    if (!useStore.getState().session) { void flow.setViewport(welcomeViewport, { duration: initial ? 0 : 250 }); return }
    let nodes = visibleNodes(useStore.getState().session)
    if (!nodes?.length) return
    if (initial && window.innerWidth < 700 && nodes[0].type !== 'attachment') nodes = nodes.slice(0, 1)
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
    const measured = flow.getNode(node.id)
    const width = measured?.measured?.width ?? node.measured?.width ?? node.width ?? CARD_WIDTH
    const height = measured?.measured?.height ?? node.measured?.height ?? node.height ?? CARD_HEIGHT
    const mobile = window.innerWidth < 700
    const left = mobile ? 24 : historyOpen ? 250 : 75
    const right = mobile ? 24 : 70
    const top = mobile ? 145 : 120
    const bottom = 160
    // Focus at reading size, bounded by the visible canvas width on small screens.
    const zoom = Math.min(1.15, Math.max(100, window.innerWidth - left - right) / width)
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
  const navigationIndex = Math.max(0, visibleNodes(session).findIndex((node) => node.id === state.selected) ?? 0)
  function navigateNode(direction: number) {
    const current = useStore.getState()
    const ordered = visibleNodes(current.session)
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
    const node = visibleNodes(useStore.getState().session).find((n) => n.id === state.navigation?.id)
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
        visibleLinks(session).filter((e) =>
          session?.contentGraph?.entities[state.selected ?? '']?.type !== 'entity' || e.kind === 'has_information' || e.kind === 'about' || e.kind === 'manual',
        ).flatMap((e) =>
          e.source === state.selected ? [e.target] : e.target === state.selected ? [e.source] : [],
        ) ?? [],
      ),
    [session, state.selected],
  )
  const nodes = useMemo(
    () =>
      visibleNodes(session).map((node): CanvasNode => {
        if (node.id !== state.editingNode || !state.editingDraft) return node
        const data = state.editingDraft
        return { ...node, type: 'user', data, width: data.kind === 'response' ? 560 : data.kind === 'entity' ? 340 : 460 }
      }).map((n): CanvasNode =>
        n.type !== 'page'
          ? { ...n, style: { ...n.style, '--node-color': nodeAccent(n, session?.contentGraph) } as CSSProperties, selected: n.id === state.selected,
              className: session?.nodes.some((node) => node.id === state.selected && node.type === 'entity') && related.has(n.id) ? 'entity-related-node' : undefined }
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
    [session, related, state.selected, state.editingNode, state.editingDraft],
  )
  const baseEdges: Edge[] = useMemo(() => {
    if (session?.protocol === 2) {
      const responses = session.nodes.filter((n) => n.type === 'response')
      const conversationEdges: Edge[] = responses.flatMap((node) => {
        const parentId = responseParentId(session, node)
        if (!parentId || !visibleNodes(session).some((n) => n.id === parentId)) return []
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
            markerEnd: { type: MarkerType.ArrowClosed, color: NODE_ACCENTS.response, markerUnits: 'userSpaceOnUse', width: 16, height: 16 },
            style: { stroke: NODE_ACCENTS.response, strokeWidth: 2.6 },
          },
        ]
      })
      const contentEdges: Edge[] = (session.contentGraph?.relations ?? []).filter((edge) => {
        // Retain answer provenance in storage, but show the entity-first route for grouped cards.
        if (edge.kind === 'has_extract' && session.contentGraph?.relations.some((r) => r.kind === 'has_information' && r.target === edge.target)) return false
        // The forward conversation edge already displays this explicit selection.
        const response = responses.find((n) => n.id === edge.source)
        return !(edge.kind === 'uses_context' && response && responseParentId(session, response) === edge.target)
      }).map((edge) => {
        const target = session.contentGraph?.entities[edge.target]
        const color = nodeAccent(session.nodes.find((node) => node.id === edge.target), session.contentGraph)
        const isImage = target?.type === 'source' && !!target.source.image && ['consulted', 'cites'].includes(edge.kind)
        return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'content',
        label: isImage ? '관련 이미지' : { has_entity: '대상', has_information: '관련 정보', about: '설명 대상', has_extract: '정보 추출', consulted: '조회', cites: '출처 표기', uses_context: '맥락 참고', related_image: '관련 이미지' }[edge.kind],
        ariaLabel: isImage ? '관련 이미지' : {
          about: '정보가 설명하는 대상 · 원문 참조 기반',
          has_entity: '응답에서 설명하는 엔티티',
          has_information: '엔티티를 설명하는 정보',
          related_image: '출처 페이지의 관련 이미지',
          has_extract: '응답에서 정보 추출',
          consulted: '응답에서 자료 조회',
          cites: '원문에 출처 표기',
          uses_context: '새 응답에서 선택한 노드를 맥락으로 참고',
        }[edge.kind],
        markerEnd: { type: MarkerType.ArrowClosed, color, markerUnits: 'userSpaceOnUse', width: 16, height: 16 },
        style: {
          stroke: color,
          strokeWidth: (edge.kind === 'about' && edge.target === state.selected) || (edge.kind === 'has_information' && edge.source === state.selected) ? 3.6 : 2.6,
          strokeDasharray: edge.kind === 'consulted' ? '4 4' : undefined,
        },
        selectable: false,
        }
      })
      const attachmentEdges: Edge[] = responses.flatMap(node => (node.data.attachments ?? []).flatMap(attachment => {
        const source = `attachment_${attachment.id}`
        if (!session.nodes.some(n => n.id === source)) return []
        return [{id: `input-${source}-${node.id}`, source, target: node.id, type: 'content',
          sourceHandle: 'attachment-output', targetHandle: 'attachment-input', label: '입력 자료',
          ariaLabel: '사용자가 첨부한 입력 자료', selectable: false, focusable: false,
          markerEnd: {type: MarkerType.ArrowClosed, color: NODE_ACCENTS.source},
          style: {stroke: NODE_ACCENTS.source, strokeWidth: 2},
        }]
      }))
      return [...conversationEdges, ...contentEdges, ...attachmentEdges]
    }
    return (
      session?.graph.relations.map((e, i) => ({
        id: `edge-${i}`,
        source: e.source,
        target: e.target,
        type: 'relation',
        markerEnd: { type: MarkerType.ArrowClosed, color: NODE_ACCENTS.page, markerUnits: 'userSpaceOnUse', width: 16, height: 16 },
        label: e.label,
        hidden: e.strength === 'weak' && !weak,
        style: {
          stroke: NODE_ACCENTS.page,
          strokeWidth: state.selectedEdge === i ? 3.4 : 2.6,
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
  const edges: Edge[] = useMemo(() => visibleLinks(session).map(link => {
    const original = baseEdges.find(e => e.id === link.id)
    const manual = link.kind === 'manual'
    const color = nodeAccent(nodes.find(n => n.id === link.target), session?.contentGraph)
    return { ...(original ?? {}), id: link.id, source: link.source, target: link.target,
      ...(manual ? { type: 'content', label: link.label, sourceHandle: link.sourceHandle ?? null, targetHandle: link.targetHandle ?? null,
        ariaLabel: `사용자 연결: ${link.label}`, style: { stroke: color, strokeWidth: 2.6, strokeDasharray: '6 4' },
        markerEnd: { type: MarkerType.ArrowClosed, color } } : {}),
      selectable: true, focusable: true, selected: state.selectedLink === link.id,
      markerEnd: { type: MarkerType.ArrowClosed, color, markerUnits: 'userSpaceOnUse', width: 16, height: 16 },
      style: { ...(manual ? { strokeDasharray: '6 4' } : original?.style), stroke: color, strokeWidth: state.selectedLink === link.id ? 4 : 2.6 },
    }
  }), [session, baseEdges, state.selectedLink, nodes])
  const arrivingGraph = useGraphArrival(session?.id, nodes, edges, Boolean(state.loadingSessionId))
  const selectedSource = visibleNodes(session).some(n => n.id === state.selected && n.type === 'page') ? session?.sources.find((s) => s.id === state.selected) : undefined
  const selectedRelation =
    state.selectedEdge === null ? undefined : session?.graph.relations[state.selectedEdge]
  const opening = Boolean(state.loadingSessionId)
  const busy = Boolean(state.activeRequest)
  useAutosizeTextarea(inputRef, state.input, !opening && !state.serverError)
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!composing.current && !busy) void state.run()
  }
  return (
    <main
      className={`workspace ${shared ? 'shared-workspace' : ''} ${historyOpen ? 'sidebar-open' : 'sidebar-closed'} ${session ? 'has-session' : 'is-empty'} ${state.serverError ? 'has-server-error' : ''} ${opening ? 'is-loading-content' : ''}`}
      aria-label="대화 캔버스"
    >
      <ReactFlow<WorkspaceNode>
        translateExtent={extent}
        nodes={(state.serverError || opening) ? [] : !session ? welcome.nodes : shared ? arrivingGraph.nodes.map(n => ({ ...n, draggable: false, connectable: false })) : arrivingGraph.nodes}
        edges={(state.serverError || opening) ? [] : !session ? welcome.edges : arrivingGraph.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        autoPanOnNodeFocus={!!session}
        nodesDraggable={!!session && !shared}
        edgesReconnectable={!!session && !shared}
        onNodesChange={changes => { if (session) state.nodesChange(changes.filter(c => c.type !== 'add' && c.type !== 'replace')) }}
        onNodeContextMenu={(event, node) => { event.preventDefault(); if (!session || shared) return; state.select(node.id); setMenu({ x: event.clientX, y: event.clientY, node: node.id }) }}
        onPaneContextMenu={event => { event.preventDefault(); if (!session || shared) return; setMenu({ x: event.clientX, y: event.clientY }) }}
        onEdgeContextMenu={(event, edge) => { event.preventDefault(); if (!session || shared) return; useStore.setState({ selectedLink: edge.id, selected: null }); setMenu({ x: event.clientX, y: event.clientY, edge: edge.id }) }}
        onEdgeClick={(_, edge) => { if (session) useStore.setState({ selectedLink: edge.id, selected: null }) }}
        onEdgeDoubleClick={(_, edge) => { if (session) state.editEdge(edge.id) }}
        onNodeClick={(event, node) => {
          if (node.type === 'welcome') return
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
          setMenu(null)
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
        nodesConnectable={!editLocked(session)}
        connectOnClick
        onConnect={state.connect}
        isValidConnection={connection => !editLocked(session) && connection.source !== connection.target}
        onReconnect={(edge, connection) => {
          const link = visibleLinks(session).find(e => e.id === edge.id)
          if (link) state.saveEdge({ ...link, ...connection, label: link.label === defaultConnectionLabel(session, link.source, link.target) ? defaultConnectionLabel(session, connection.source, connection.target) : link.label })
        }}
        deleteKeyCode={null}
        selectionKeyCode={null}
        aria-label="페이지 관계 캔버스"
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Lines} gap={28} lineWidth={0.6} color="#e2e6df" />
      </ReactFlow>
      <ActionToast />
      {!shared && session && menu && <div className="canvas-context-menu panel" role="menu" aria-label="캔버스 편집 메뉴" style={{ left: Math.min(menu.x, window.innerWidth - 228), top: Math.min(menu.y, window.innerHeight - 280) }} onPointerDown={e => e.stopPropagation()}>
        {!menu.node && !menu.edge && <button role="menuitem" disabled={Boolean(state.activeRequest || state.loadingSessionId || session && editLocked(session))} onClick={() => {
          state.createNode(flow.screenToFlowPosition({ x: menu.x, y: menu.y }), flow.getViewport()); setMenu(null)
        }}>노드 생성</button>}
        {menu.node && <>
          <button role="menuitem" onClick={() => { state.copyNode(menu.node!); setMenu(null) }}>복사하기 <kbd>Ctrl/⌘ C</kbd></button>
          <button role="menuitem" disabled={editLocked(session)} onClick={() => { state.editNode(menu.node!); setMenu(null) }}>수정하기 <kbd>F2</kbd></button>
          <button role="menuitem" disabled={editLocked(session)} onClick={() => { state.deleteNode(menu.node!); setMenu(null) }}>삭제하기 <kbd>Delete</kbd></button>
        </>}
        {menu.edge && <>
          <button role="menuitem" disabled={editLocked(session)} onClick={() => { state.editEdge(menu.edge!); setMenu(null) }}>수정하기</button>
          <button role="menuitem" disabled={editLocked(session)} onClick={() => { state.deleteEdge(menu.edge!); setMenu(null) }}>삭제하기</button>
        </>}
        <button role="menuitem" disabled={!state.clipboard || Boolean(state.activeRequest || state.loadingSessionId || session && editLocked(session))} onClick={() => { state.pasteNode(flow.screenToFlowPosition({ x: menu.x, y: menu.y }), flow.getViewport()); setMenu(null) }}>붙여넣기 <kbd>Ctrl/⌘ V</kbd></button>
        <button role="menuitem" disabled={!state.undoStack.length || editLocked(session)} onClick={() => { state.undo(); setMenu(null) }}>실행 취소 <kbd>Ctrl/⌘ Z</kbd></button>
        <button role="menuitem" disabled={!state.redoStack.length || editLocked(session)} onClick={() => { state.redo(); setMenu(null) }}>다시 실행 <kbd>Ctrl/⌘ ⇧ Z</kbd></button>
      </div>}
      {state.serverError ? (
        <ServerErrorPage retrying={state.retryingServer || opening} onRetry={() => void (state.failedSessionId ? state.open(state.failedSessionId) : state.initialize())} />
      ) : (
      <>
      <div className="canvas-topbar">
      {shared ? <header className="sidebar-header"><a className="brand" href="/" aria-label="Rabbit Hole" data-tooltip="새 대화 열기" data-tooltip-position="bottom"><RabbitIcon /><span>Rabbit Hole</span></a></header> : <header className="sidebar-header">
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
      </header>}
      {!opening && session && (
        <div className="canvas-heading">
          <div>
            <h1>{(session.title || session.query).split('\n')[0]}</h1>
          </div>
          <span className="canvas-metadata">
            {shared && <span className="shared-label">공유 · 읽기 전용</span>}
            <span className="canvas-node-counts">
            {session.protocol === 2
              ? `${visibleNodes(session).filter((n) => n.type === 'response' || n.type === 'user' && n.data.kind === 'response').length} 응답 · ${visibleNodes(session).filter((n) => n.type === 'information' || n.type === 'user' && n.data.kind === 'information').length} 정보 · ${visibleNodes(session).filter((n) => n.type === 'entity' || n.type === 'user' && n.data.kind === 'entity').length} 엔티티 · ${visibleNodes(session).filter((n) => n.type === 'source' || n.type === 'attachment' || n.type === 'user' && ['source', 'image'].includes(n.data.kind)).length} 출처`
              : `${session.sources.length}개의 페이지`}
            </span>
            <ResponseTimer timings={session.responseTimings} />
          </span>
          {session.mode === 'sample' && <span className="sample-badge">이전 가상 데이터 기록</span>}
        </div>
      )}
      {!opening && Boolean(visibleNodes(session).length) && (
        <nav className="node-navigation panel" aria-label="노드 탐색">
          {!shared && session && <CanvasShareActions key={session.id} session={session} />}
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
            {navigationIndex + 1}/{visibleNodes(session).length}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="다음 노드"
            data-tooltip="다음 노드 · D"
            data-tooltip-position="bottom"
            aria-keyshortcuts="d"
            disabled={navigationIndex >= visibleNodes(session).length - 1}
            onClick={() => navigateNode(1)}
          >
            <ArrowRight size={16} />
          </Button>
        </nav>
      )}
      </div>
      {!shared && <aside
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
          최근 대화 {!state.retryingServer && <span>{state.history.length}</span>}
        </h2>
        <div className="history-list" aria-busy={state.retryingServer}>
          {state.retryingServer && <HistoryLoading />}
          {!state.retryingServer && !state.history.length && <p className="history-empty">대화 기록이 없습니다</p>}
          {!state.retryingServer && state.history.map((h) => (
            <div className={`history-row ${(state.loadingSessionId ?? session?.id) === h.id ? 'active' : ''}`} key={h.id}>
              <button
                className="history-item"
                onClick={() => {
                  void state.open(h.id)
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
        <SidebarSettings />
      </aside>}
      {opening && <HistoryLoading canvas />}
      {!opening && session?.protocol !== 2 && <AnswerPanel />}
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
      {!opening && (state.error || state.storageError) && (
        <ErrorToast
          key={`${state.error ?? ''}:${state.storageError ?? ''}`}
          message={state.error || '기록을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.'}
          onDismiss={dismissError}
        />
      )}
      {!opening && <div className="composer-area">
        {busy && (
          <div className="agent-status" role="status">
            <RabbitLoader />
            {state.stage}
            <span>받은 응답부터 캔버스에 표시합니다.</span>
          </div>
        )}
        {!shared && !busy && session && session.mode === 'live' && session.protocol === 2 && (
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
      {!opening && <nav className="canvas-tools panel" aria-label="캔버스 도구">
        {!shared && session && <><Button variant="ghost" size="icon" aria-label="실행 취소" data-tooltip="실행 취소 · Ctrl/⌘+Z" disabled={!state.undoStack.length || editLocked(session)} onClick={state.undo}><Undo2 /></Button>
        <Button variant="ghost" size="icon" aria-label="다시 실행" data-tooltip="다시 실행 · Ctrl/⌘+Shift+Z" disabled={!state.redoStack.length || editLocked(session)} onClick={state.redo}><Redo2 /></Button>
        <i /></>}
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
      </nav>}
        {!shared && <form className={`composer panel ${state.replyTo ? 'has-reply' : ''} ${state.requestedTool || state.draftAttachments.length ? 'has-tool' : ''}`} onSubmit={submit}>
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
          <AttachmentTray items={state.draftAttachments} remove={state.removeAttachment} disabled={busy} />
          <ComposerTools selected={state.requestedTool} onSelect={state.setRequestedTool}
            disabled={busy} focusInput={() => inputRef.current?.focus()} onAttach={files => void state.addAttachments(files)} />
          <textarea
            ref={inputRef}
            rows={1}
            aria-label="메시지 입력"
            placeholder={
              state.requestedTool === 'read_page' ? 'URL과 궁금한 내용을 입력하세요' :
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
            <Button type="submit" size="icon" aria-label="메시지 보내기" disabled={(!state.input.trim() && !state.draftAttachments.length) || state.draftAttachments.some(a => a.status !== 'ready')}>
              <ArrowUp />
            </Button>
          )}
        </form>}
        {!shared && session?.mode === 'sample' && (
          <p className="composer-note">
            이전 가상 데이터 기록입니다. 메시지를 보내면 새로운 대화를 시작합니다.
          </p>
        )}
      </div>}
      {!opening && session?.sources.length ? (
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

      </>
      )}
    </main>
  )
}
export default function App() {
  if (window.location.pathname.replace(/\/$/, '') === '/landing') return <LandingPlaceholder />
  const shareMatch = window.location.pathname.match(/^\/share\/([^/]+)\/?$/)
  return (
    <ReactFlowProvider>
      {shareMatch ? <SharedCanvasPage id={shareMatch[1]}><Workspace shared /></SharedCanvasPage> : <Workspace />}
      <TooltipLayer />
    </ReactFlowProvider>
  )
}
