import { useEffect, useState } from 'react'

export function ErrorToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    const fade = window.setTimeout(() => setLeaving(true), 4000)
    const dismiss = window.setTimeout(onDismiss, 4300)
    return () => { window.clearTimeout(fade); window.clearTimeout(dismiss) }
  }, [onDismiss])
  return (
    <div className={`error-toast ${leaving ? 'is-leaving' : ''}`} role="alert" aria-atomic="true">
      {message}
    </div>
  )
}
