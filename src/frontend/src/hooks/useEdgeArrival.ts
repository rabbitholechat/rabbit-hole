import { useLayoutEffect, useRef, useState } from 'react'
import type { EdgeProps } from '@xyflow/react'

export type EdgeArrival = { delay: number; claimed: boolean }

// The ticket belongs to the canvas, so an edge remount cannot replay its entrance.
export function useEdgeArrival(data: EdgeProps['data']) {
  const ticket = data?.arrival as EdgeArrival | undefined
  const attempted = useRef<EdgeArrival | undefined>(undefined)
  const [delay, setDelay] = useState<number | null>(null)
  useLayoutEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (attempted.current !== ticket) {
      attempted.current = ticket
      const available = ticket && !ticket.claimed
      if (ticket) ticket.claimed = true
      setDelay(available && !motion.matches ? ticket.delay : null)
    }
    const reduce = () => { if (motion.matches) setDelay(null) }
    motion.addEventListener('change', reduce)
    return () => motion.removeEventListener('change', reduce)
  }, [ticket])
  return { delay, finish: () => setDelay(null) }
}
