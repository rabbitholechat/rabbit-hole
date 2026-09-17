import type { CoordinateExtent, Viewport } from '@xyflow/react'
import type { CanvasNode } from '../types'

const BASE_WIDTH = 2400
const BASE_HEIGHT = 1600

/** Canvas coordinates: keep a base area, room around every node, and the current view. */
export function canvasBounds(
  nodes: CanvasNode[],
  viewport: Viewport,
  screen: { width: number; height: number },
): CoordinateExtent {
  const viewWidth = screen.width / viewport.zoom
  const viewHeight = screen.height / viewport.zoom
  const paddingX = Math.max(400, viewWidth / 2)
  const paddingY = Math.max(300, viewHeight / 2)
  let left = Math.min(-400, -viewport.x / viewport.zoom)
  let top = Math.min(-300, -viewport.y / viewport.zoom)
  let right = Math.max(BASE_WIDTH - 400, screen.width + 400, (screen.width - viewport.x) / viewport.zoom)
  let bottom = Math.max(BASE_HEIGHT - 300, screen.height + 300, (screen.height - viewport.y) / viewport.zoom)
  for (const node of nodes) {
    const width = node.measured?.width ?? node.width ?? (node.type === 'response' ? 560 : 280)
    const height = node.measured?.height ?? node.height ?? 206
    left = Math.min(left, node.position.x - paddingX)
    top = Math.min(top, node.position.y - paddingY)
    right = Math.max(right, node.position.x + width + paddingX)
    bottom = Math.max(bottom, node.position.y + height + paddingY)
  }
  return [
    [left, top],
    [right, bottom],
  ]
}
