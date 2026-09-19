import { useEffect, useRef, useState } from 'react'
import { Check, FileText, Globe2, Image, Link, Plus, X } from 'lucide-react'
import type { RequestedTool } from '../types'

const choices = [
  { id: 'web_search', label: '웹 검색', description: '웹에서 자료를 찾아 답변해요', Icon: Globe2 },
  { id: 'read_page', label: 'URL 접근', description: '입력한 페이지를 읽고 답변해요', Icon: Link },
] as const

export function ComposerTools({ selected, onSelect, disabled, focusInput }: {
  selected: RequestedTool | null
  onSelect: (tool: RequestedTool | null) => void
  disabled: boolean
  focusInput: () => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const firstChoice = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    firstChoice.current?.focus()
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        trigger.current?.focus()
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  const choice = choices.find((item) => item.id === selected)
  return <>
    {choice && <div className="composer-tool-slot">
      <span className="composer-tool-chip">
        <choice.Icon size={14} aria-hidden="true" />{choice.label}
        <button type="button" aria-label={`${choice.label} 선택 해제`} disabled={disabled}
          onClick={() => { onSelect(null); focusInput() }}><X size={13} /></button>
      </span>
    </div>}
    <div className="composer-tools" ref={root} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
    }}>
      <button type="button" className={`composer-tool-trigger ${selected ? 'is-selected' : ''}`}
        ref={trigger} aria-label="도구 추가" aria-expanded={open && !disabled} aria-haspopup="dialog"
        aria-controls="composer-tool-menu" disabled={disabled} onClick={() => setOpen(!open)}>
        <Plus size={21} aria-hidden="true" />
      </button>
      {open && !disabled && <div id="composer-tool-menu" className="composer-tool-menu" role="dialog" aria-label="도구 선택">
        <p>이번 질문에 사용할 도구</p>
        {choices.map(({ id, label, description, Icon }, index) => <button type="button" key={id}
          ref={index === 0 ? firstChoice : undefined} aria-pressed={selected === id}
          onClick={() => { onSelect(selected === id ? null : id); setOpen(false); focusInput() }}>
          <Icon size={18} aria-hidden="true" /><span><strong>{label}</strong><small>{description}</small></span>
          {selected === id && <Check size={15} aria-hidden="true" />}
        </button>)}
        <div className="composer-tool-divider" />
        <button type="button" disabled><FileText size={18} aria-hidden="true" /><span><strong>파일 첨부</strong></span><small>준비 중</small></button>
        <button type="button" disabled><Image size={18} aria-hidden="true" /><span><strong>이미지 첨부</strong></span><small>준비 중</small></button>
        <p className="composer-tool-hint">선택하지 않아도 필요한 도구를 알아서 사용해요.</p>
      </div>}
    </div>
  </>
}
