import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'

export function Select({ label, value, options, onChange, disabled = false }: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 260 })
  function show() { setActive(Math.max(0, options.findIndex(option => option.value === value))); setOpen(true) }
  function close() { setOpen(false); trigger.current?.focus({ preventScroll: true }) }
  useLayoutEffect(() => {
    if (!open || !trigger.current) return
    const rect = trigger.current.getBoundingClientRect()
    const height = Math.min(260, options.length * 42 + 16)
    const below = window.innerHeight - rect.bottom - 12
    const above = rect.top - 12
    const upward = below < height && above > below
    const maxHeight = Math.max(80, Math.min(height, upward ? above : below))
    setPosition({ left: Math.min(Math.max(8, rect.left), window.innerWidth - Math.min(rect.width, window.innerWidth - 16) - 8), top: upward ? rect.top - maxHeight - 6 : rect.bottom + 6, width: Math.min(rect.width, window.innerWidth - 16), maxHeight })
  }, [open, options.length])
  useEffect(() => { if (open) menu.current?.querySelectorAll<HTMLButtonElement>('[role=option]')[active]?.focus({ preventScroll: true }) }, [open, active])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false)
    }
    const resize = () => setOpen(false)
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', resize)
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', resize) }
  }, [open])
  return <div className="select-field">
    <span id={`${id}-label`}>{label}</span>
    <button ref={trigger} type="button" className="select-trigger" role="combobox" aria-labelledby={`${id}-label`} aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? `${id}-options` : undefined} disabled={disabled}
      onClick={() => open ? close() : show()} onKeyDown={event => {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); show() }
      }}>
      <span>{options.find(option => option.value === value)?.label ?? value}</span><ChevronDown size={15} aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={menu} id={`${id}-options`} role="listbox" aria-labelledby={`${id}-label`} className="dropdown-menu" style={position}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={event => {
        event.stopPropagation()
        if (event.key === 'Escape') { event.preventDefault(); close() }
        if (event.key === 'Tab') close()
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          setActive(event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length)
        }
      }}>
      {options.map((option, index) => <button key={option.value} role="option" aria-selected={option.value === value} tabIndex={active === index ? 0 : -1} type="button"
        onClick={() => { onChange(option.value); close() }}>
        <span>{option.label}</span>{option.value === value && <Check size={15} aria-hidden="true" />}
      </button>)}
    </div>, document.body)}
  </div>
}
