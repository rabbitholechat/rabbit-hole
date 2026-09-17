import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export function TooltipLayer() {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function show(event: Event) {
      setTarget(event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tooltip]') : null)
    }
    function hide() { setTarget(null) }
    function leave(event: MouseEvent) {
      if (!(event.relatedTarget instanceof Node) || !target?.contains(event.relatedTarget)) hide()
    }
    function key(event: KeyboardEvent) { if (event.key === 'Escape') hide() }
    document.addEventListener('pointerover', show)
    document.addEventListener('pointerout', leave)
    document.addEventListener('focusin', show)
    document.addEventListener('focusout', hide)
    document.addEventListener('pointerdown', hide)
    document.addEventListener('keydown', key)
    document.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      document.removeEventListener('pointerover', show)
      document.removeEventListener('pointerout', leave)
      document.removeEventListener('focusin', show)
      document.removeEventListener('focusout', hide)
      document.removeEventListener('pointerdown', hide)
      document.removeEventListener('keydown', key)
      document.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [target])
  useLayoutEffect(() => {
    if (!target || !ref.current) return
    const anchor = target.getBoundingClientRect(), box = ref.current.getBoundingClientRect()
    const left = Math.max(8, Math.min(window.innerWidth - box.width - 8, anchor.left + (anchor.width - box.width) / 2))
    const above = anchor.top - box.height - 8
    const top = Math.max(8, Math.min(window.innerHeight - box.height - 8,
      target.dataset.tooltipPosition === 'bottom' || above < 8 ? anchor.bottom + 8 : above))
    setPosition({ left, top })
  }, [target])
  if (!target?.isConnected || !target.dataset.tooltip) return null
  return createPortal(<div ref={ref} role="tooltip" className="global-tooltip" style={position}>
    {target.dataset.tooltip}
  </div>, document.body)
}
