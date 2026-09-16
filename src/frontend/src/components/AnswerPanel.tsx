import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChevronDown, ChevronUp, Sparkles } from 'lucide-react'
import { useStore } from '../store'
import { Button } from './ui/button'
export function AnswerPanel() {
  const session = useStore(s => s.session), select = useStore(s => s.select)
  const [expanded, setExpanded] = useState(false)
  const answer = session?.answer
  if (!answer) return null
  const claims = expanded ? answer.claims : answer.claims.slice(0, 1)
  return <section className={`answer-panel panel ${expanded ? 'expanded' : ''}`} aria-label="AI 답변">
    <header><span><Sparkles size={16}/> AI 한눈에 보기</span><Button variant="ghost" size="icon" aria-label={expanded ? '답변 접기' : '답변 펼치기'} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? <ChevronUp/> : <ChevronDown/>}</Button></header>
    <div className="answer-body">
      {claims.map((claim, i) => <div className="claim" key={i}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ children }) => <span>{children}</span>, img: () => null }}>{claim.text}</ReactMarkdown>
        <span className="citations">{[...new Set(claim.evidence.map(e => e.source_id))].map(id => <button key={id} onClick={() => select(id)} aria-label={`출처 ${session.sources.findIndex(s => s.id === id) + 1} 선택`}>{session.sources.findIndex(s => s.id === id) + 1}</button>)}</span>
      </div>)}
      {!answer.claims.length && <p>확인된 자료만으로 답변을 확정하기 어렵습니다. 페이지를 직접 비교해 보세요.</p>}
      {expanded && <p className="answer-limitation">{answer.limitation}</p>}
    </div>
    <footer>{session.mode === 'sample' ? '디자인 예시 · 가상 데이터' : 'AI 요약은 출처와 함께 확인하세요.'}{!expanded && answer.claims.length > 1 && <button onClick={() => setExpanded(true)}>자세히 보기</button>}</footer>
  </section>
}
