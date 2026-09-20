import { visibleNodes } from './canvasEditing'
import { safeUrl } from './utils'
import type { Session } from '../types'

// Freeze the rendered canvas, including SVG edges and card styles, without app state or scripts.
const properties =
  `display position inset top right bottom left box-sizing width height min-width min-height max-width max-height margin padding border border-radius border-top border-right border-bottom border-left background background-color background-image background-size background-position box-shadow color font font-family font-size font-weight font-style line-height letter-spacing text-align text-decoration text-transform text-overflow white-space overflow-wrap word-break vertical-align flex flex-direction flex-wrap flex-grow flex-shrink flex-basis align-items align-content align-self justify-content justify-items justify-self gap row-gap column-gap grid-template-columns grid-template-rows grid-column grid-row table-layout border-collapse border-spacing caption-side list-style opacity visibility overflow overflow-x overflow-y z-index transform transform-origin transform-box object-fit object-position fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin marker-end paint-order pointer-events`.split(
    ' ',
  )

function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}

function freezeCanvas(viewport: HTMLElement): HTMLElement {
  const clone = viewport.cloneNode(true) as HTMLElement
  const source = [viewport, ...viewport.querySelectorAll<HTMLElement | SVGElement>('*')]
  const target = [clone, ...clone.querySelectorAll<HTMLElement | SVGElement>('*')]
  source.forEach((element, index) => {
    const copy = target[index]
    const computed = getComputedStyle(element)
    copy.removeAttribute('style')
    for (const property of properties) {
      const value = computed.getPropertyValue(property)
      // SVG marker references must resolve within the exported document.
      if (value)
        copy.style.setProperty(property, value.replace(/url\(["']?[^#)"']*#([^)"']+)["']?\)/g, 'url(#$1)'))
    }
    copy.style.animation = 'none'
    copy.style.transition = 'none'
    copy.removeAttribute('mask')
    copy.removeAttribute('autofocus')
    copy.removeAttribute('contenteditable')
    copy.removeAttribute('data-tooltip')
    for (const attribute of [...copy.attributes])
      if (/^on/i.test(attribute.name)) copy.removeAttribute(attribute.name)
    if (copy instanceof HTMLButtonElement) {
      copy.disabled = true
      copy.tabIndex = -1
    }
    if (copy instanceof HTMLAnchorElement) {
      const href = safeUrl(copy.href)
      if (href) {
        copy.href = href
        copy.target = '_blank'
        copy.rel = 'noopener noreferrer'
      } else copy.removeAttribute('href')
    }
    if (copy instanceof HTMLImageElement) {
      const src = safeUrl(element instanceof HTMLImageElement ? element.currentSrc || element.src : '')
      if (src) copy.src = src
      else copy.removeAttribute('src')
      copy.removeAttribute('srcset')
    }
  })
  clone
    .querySelectorAll(
      'script, iframe, object, embed, .react-flow__edge-interaction, .edge-inline-editor, .inline-editor, .connection-reveal',
    )
    .forEach((element) => element.remove())
  // Keep card geometry while omitting action and navigation controls from the export.
  clone
    .querySelectorAll<HTMLElement>('.response-actions, .previous-node, .node-button')
    .forEach((control) => {
      const spacer = document.createElement('span')
      spacer.style.cssText = control.style.cssText
      spacer.style.visibility = 'hidden'
      spacer.style.pointerEvents = 'none'
      spacer.setAttribute('aria-hidden', 'true')
      control.replaceWith(spacer)
    })
  // Related-information titles and edge labels are content, even when the app uses buttons.
  clone.querySelectorAll('button').forEach((button) => {
    const label = document.createElement('span')
    label.style.cssText = button.style.cssText
    label.className = button.className
    label.append(...button.childNodes)
    button.replaceWith(label)
  })
  return clone
}

export function canvasHtml(
  session: Session,
  viewport = document.querySelector<HTMLElement>('.react-flow__viewport'),
  externalFonts = true,
): string {
  if (!viewport) throw Error('캔버스가 준비되지 않았습니다.')
  const nodes = visibleNodes(session)
  const elements = new Map(
    [...viewport.querySelectorAll<HTMLElement>('.react-flow__node')].map((element) => [
      element.dataset.id,
      element,
    ]),
  )
  if (!nodes.length || nodes.some((node) => !elements.has(node.id)))
    throw Error('캔버스가 준비되지 않았습니다.')
  const bounds = nodes.map((node) => {
    const element = elements.get(node.id)!
    return {
      ...node.position,
      width: element.offsetWidth || node.measured?.width || node.width || 460,
      height: element.offsetHeight || node.measured?.height || node.height || 240,
    }
  })
  for (const path of viewport.querySelectorAll<SVGPathElement>('.react-flow__edge-path')) {
    if (typeof path.getBBox === 'function') {
      const box = path.getBBox()
      bounds.push({ x: box.x, y: box.y, width: box.width, height: box.height })
    }
  }
  const padding = 80
  const left = Math.min(...bounds.map((node) => node.x)) - padding
  const top = Math.min(...bounds.map((node) => node.y)) - padding
  const width = Math.ceil(Math.max(...bounds.map((node) => node.x + node.width)) - left + padding)
  const height = Math.ceil(Math.max(...bounds.map((node) => node.y + node.height)) - top + padding)
  const clone = freezeCanvas(viewport)
  clone.style.transform = `translate(${-left}px, ${-top}px)`
  clone.style.transformOrigin = '0 0'
  clone.style.position = 'absolute'
  clone.style.inset = '0 auto auto 0'
  clone.style.width = `${width}px`
  clone.style.height = `${height}px`
  clone.style.overflow = 'visible'
  clone.style.pointerEvents = 'auto'
  const title = session.title || session.query || 'Rabbit Hole 캔버스'
  // A canvas-sized PDF page retains spatial relationships instead of splitting cards into a list.
  // Bound physical page dimensions for PDF viewers while keeping vector text and edges.
  const printScale = Math.min(1, 14000 / width, 14000 / height)
  const pageWidth = Math.ceil(width * printScale)
  const pageHeight = Math.ceil(height * printScale)
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escape(title)}</title>
<style>
*{box-sizing:border-box}body{margin:0;font:14px Pretendard,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#29322e;background:#fafaf8}header{height:64px;padding:12px 20px;display:flex;align-items:center;gap:16px;border-bottom:1px solid #e1e6e2;background:white}h1{font-size:16px;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}header small{color:#76827b;white-space:nowrap}nav{display:flex;gap:6px;margin-left:auto}nav button{border:1px solid #dce3de;background:white;border-radius:8px;padding:7px 12px;cursor:pointer;white-space:nowrap}#canvas-window{height:calc(100vh - 64px);overflow:auto}#canvas-space{position:relative}#canvas-scene{position:absolute;left:0;top:0;width:${width}px;height:${height}px;transform-origin:0 0;background-color:#fafaf8;background-image:linear-gradient(#e2e6df 1px,transparent 1px),linear-gradient(90deg,#e2e6df 1px,transparent 1px);background-size:28px 28px}.react-flow__handle{visibility:hidden!important}a{color:inherit}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}
@page{size:${pageWidth}px ${pageHeight}px;margin:0}@media print{html,body{width:${pageWidth}px;height:${pageHeight}px;overflow:hidden}header{display:none}#canvas-window{height:${pageHeight}px;width:${pageWidth}px;overflow:visible}#canvas-space{width:${pageWidth}px!important;height:${pageHeight}px!important}#canvas-scene{transform:scale(${printScale})!important}}
</style></head><body><header><h1>${escape(title)}</h1><small>Rabbit Hole · ${nodes.length}개 노드</small><nav aria-label="캔버스 보기"><button id="zoom-out" aria-label="축소">−</button><button id="fit">화면 맞춤</button><button id="zoom-in" aria-label="확대">+</button></nav></header><main id="canvas-window" aria-label="내보낸 캔버스"><div id="canvas-space"><div id="canvas-scene">${clone.outerHTML}</div></div></main>
<script>
(()=>{const width=${width},height=${height};const view=document.getElementById('canvas-window'),space=document.getElementById('canvas-space'),scene=document.getElementById('canvas-scene');let zoom=1;function resize(next){zoom=Math.max(.02,Math.min(2,next));space.style.width=(width*zoom)+'px';space.style.height=(height*zoom)+'px';scene.style.transform='scale('+zoom+')'}function fit(){resize(Math.min(1,view.clientWidth/width,view.clientHeight/height))}document.getElementById('fit').onclick=fit;document.getElementById('zoom-in').onclick=()=>resize(zoom*1.25);document.getElementById('zoom-out').onclick=()=>resize(zoom/1.25);fit()})();
</script>${externalFonts ? '<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css">' : ''}</body></html>`
}

export function downloadHtml(session: Session) {
  const url = URL.createObjectURL(new Blob([canvasHtml(session)], { type: 'text/html;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${(session.title || session.query || 'canvas').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').slice(0, 80)}.html`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function printCanvas(session: Session, popup: Window) {
  popup.opener = null
  const html = canvasHtml(session, document.querySelector<HTMLElement>('.react-flow__viewport'), false)
  popup.document.open()
  popup.addEventListener(
    'load',
    () => {
      popup.focus()
      popup.print()
    },
    { once: true },
  )
  popup.document.write(html)
  // Reuse already loaded font faces; printing must not wait on another CDN request.
  document.fonts.forEach((face) => popup.document.fonts.add(face))
  popup.document.close()
}
