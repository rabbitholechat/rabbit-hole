import { useCallback } from 'react'
import { useStore } from '../store'
import { ErrorToast } from './ErrorToast'

export function ActionToast() {
  const notice = useStore(s => s.actionNotice)
  const hasError = useStore(s => Boolean(s.error || s.storageError || s.serverError))
  const dismiss = useCallback(() => useStore.setState({ actionNotice: null }), [])
  return notice && !hasError ? <ErrorToast key={notice.id} className="action-toast" role="status" message={notice.message} onDismiss={dismiss} /> : null
}
