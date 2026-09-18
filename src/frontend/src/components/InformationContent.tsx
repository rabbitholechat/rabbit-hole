import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CardPresentation, GroundedText } from '../types'

function OriginalPassages({ value, close }: { value: GroundedText; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  return createPortal(<dialog ref={dialog} className="information-original-dialog" aria-label="답변 원문"
    onClose={close} onCancel={close} onClick={(event) => {
      event.stopPropagation()
      if (event.target === event.currentTarget) close()
    }}>
    <header><h3>답변 원문</h3><button type="button" className="node-button" onClick={close}>닫기</button></header>
    <p>{value.text}</p>
    {value.references.map((ref, index) => <blockquote key={`${ref.start}:${ref.end}:${index}`}>{ref.quote}</blockquote>)}
  </dialog>, document.body)
}
function GroundedValue({ value }: { value: GroundedText }) {
  const [open, setOpen] = useState(false)
  return <div className="grounded-value">
    <span>{value.text}</span>
    <button type="button" className="information-reference" aria-label={`원문 보기: ${value.text}`}
      onClick={(event) => { event.stopPropagation(); setOpen(true) }}>원문</button>
    {open && <OriginalPassages value={value} close={() => setOpen(false)} />}
  </div>
}
export function InformationContent({ card }: { card: CardPresentation }) {
  return <div className="information-presentation">
    {card.summary && <div className="information-summary"><GroundedValue value={card.summary} /></div>}
    {card.table && <div className="information-table-scroll nowheel" tabIndex={0} role="region" aria-label={`${card.heading} 비교표`}>
      <table style={{ minWidth: card.table.columns.length * 110 }}>
        <thead><tr>{card.table.columns.map((column, index) => <th key={index} scope="col"><GroundedValue value={column} /></th>)}</tr></thead>
        <tbody>{card.table.rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) =>
          <td key={cellIndex}>{cell ? <GroundedValue value={cell} /> : <span aria-label="답변에 정보 없음">—</span>}</td>)}</tr>)}</tbody>
      </table>
    </div>}
    {card.sections.map((section, index) => <section className={`information-section information-${section.layout}`} key={index}>
      {section.heading && <h3>{section.heading}</h3>}
      {section.layout === 'text' ? section.items.map((item, i) => <GroundedValue key={i} value={item} />) :
        section.layout === 'steps' ? <ol>{section.items.map((item, i) => <li key={i}><GroundedValue value={item} /></li>)}</ol> :
          <ul>{section.items.map((item, i) => <li key={i}><GroundedValue value={item} /></li>)}</ul>}
    </section>)}
  </div>
}
