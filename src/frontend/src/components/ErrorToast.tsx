import { useEffect, useState } from 'react'

export function ErrorToast({ message, onDismiss, role = 'alert', className = '' }: { message: string; onDismiss: () => void; role?: 'alert' | 'status'; className?: string }) {
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    const fade = window.setTimeout(() => setLeaving(true), 4000)
    const dismiss = window.setTimeout(onDismiss, 4300)
    return () => { window.clearTimeout(fade); window.clearTimeout(dismiss) }
  }, [onDismiss])
  return (
    <div className={`error-toast ${className} ${leaving ? 'is-leaving' : ''}`} role={role} aria-atomic="true">
      {message}
    </div>
  )
}
