import { useLayoutEffect, useRef, useState } from 'react'

// Use rendered content height rather than text length, including Markdown and wrapping.
export function useCollapsibleContent(content: string, collapsed?: boolean) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [canCollapse, setCanCollapse] = useState(false)
  useLayoutEffect(() => {
    const element = contentRef.current
    if (!element) { setCanCollapse(false); return }
    const measure = () => {
      const limit = parseFloat(getComputedStyle(element).getPropertyValue('--collapsed-content-height'))
      setCanCollapse(Number.isFinite(limit) && element.scrollHeight > limit + 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [content, collapsed])
  return { contentRef, canCollapse }
}
