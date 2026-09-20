import { useEffect, useRef, useState } from 'react'
import { Copy, Download, Share2 } from 'lucide-react'
import { Button } from './ui/button'
import { shareApi } from '../lib/shareApi'
import { useStore } from '../store'
import type { Session } from '../types'

export function CanvasShareActions({ session }: { session: Session }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [link, setLink] = useState('')
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function close(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false)
        setMessage('')
        setLink('')
      }
    }
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
        setLink('')
        setMessage('')
      }
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [])
  async function share() {
    setBusy(true)
    setMessage('')
    setLink('')
    setOpen(false)
    try {
      const { id } = await shareApi.create(structuredClone(session))
      const url = `${window.location.origin}/share/${encodeURIComponent(id)}`
      setLink(url)
      try {
        await navigator.clipboard.writeText(url)
        copiedNotice()
      } catch {
        setMessage('링크를 만들었습니다. 아래 링크를 직접 복사해 주세요.')
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '공유하지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }
  function copiedNotice() {
    setMessage('')
    useStore.setState({ actionNotice: { id: crypto.randomUUID(), message: '공유 링크를 복사했습니다' } })
  }
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link)
      copiedNotice()
    } catch {
      setMessage('복사하지 못했습니다. 링크를 선택해 직접 복사해 주세요')
    }
  }
  async function exportCanvas(format: 'html' | 'pdf') {
    setOpen(false)
    // Open synchronously so browsers retain the click's popup permission.
    const popup = format === 'pdf' ? window.open('', '_blank') : null
    if (format === 'pdf' && !popup) {
      setMessage('PDF 저장을 위해 팝업을 허용해 주세요.')
      return
    }
    if (popup) {
      popup.opener = null
      popup.document.title = 'PDF 문서 준비 중'
    }
    try {
      const exporter = await import('../lib/canvasExport')
      if (popup) {
        exporter.printCanvas(session, popup)
        setMessage('인쇄 창에서 대상을 PDF로 저장으로 선택해 주세요.')
      } else exporter.downloadHtml(session)
    } catch {
      popup?.close()
      setMessage('문서를 내보내지 못했습니다. 다시 시도해 주세요.')
    }
  }
  return (
    <div className="canvas-share-actions" ref={root}>
      <Button
        variant="ghost"
        size="icon"
        aria-label="공유"
        data-tooltip={busy ? '공유 링크 생성 중' : '공유'}
        data-tooltip-position="bottom"
        disabled={busy}
        onClick={() => void share()}
      >
        <Share2 size={16} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="다운로드"
        data-tooltip="다운로드"
        data-tooltip-position="bottom"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => {
          setOpen(!open)
          setLink('')
          setMessage('')
        }}
      >
        <Download size={16} />
      </Button>
      {open && (
        <div className="canvas-export-menu panel" role="menu" aria-label="다운로드 형식">
          <button role="menuitem" onClick={() => void exportCanvas('html')}>
            HTML 다운로드
          </button>
          <button role="menuitem" onClick={() => void exportCanvas('pdf')}>
            PDF로 저장
          </button>
        </div>
      )}
      {(message || link) && (
        <div
          className="canvas-share-result panel"
          role="dialog"
          aria-label={link ? '공유 링크' : '캔버스 알림'}
        >
          {message && <p role="status">{message}</p>}
          {link && (
            <div className="canvas-share-link">
              <input aria-label="공유 링크" value={link} readOnly onFocus={(e) => e.target.select()} />
              <button
                type="button"
                aria-label="복사하기"
                data-tooltip="복사하기"
                onClick={() => void copyLink()}
              >
                <Copy size={16} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
