import { useLayoutEffect, type RefObject } from 'react'

// CSS supplies the height cap; measure again for wrapping, deletion and composer remounts.
export function useAutosizeTextarea(ref: RefObject<HTMLTextAreaElement | null>, value: string, visible: boolean) {
  useLayoutEffect(() => {
    const input = ref.current
    if (!visible || !input) return
    const resize = () => {
      input.style.height = 'auto'
      input.style.height = `${input.scrollHeight}px`
    }
    resize()
    let width = input.clientWidth
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === width) return
      width = input.clientWidth
      resize()
    })
    observer.observe(input)
    window.addEventListener('resize', resize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', resize)
    }
  }, [ref, value, visible])
}
