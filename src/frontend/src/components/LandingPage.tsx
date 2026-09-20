import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowRight, ArrowUpRight, Github, X, ZoomIn } from 'lucide-react'
import { RabbitIcon } from './RabbitIcon'
import { landingImages } from './landingImages'
import './LandingPage.css'

type ImageKey = keyof typeof landingImages
const edits: { key: ImageKey; title: string; text: string }[] = [
  {
    key: 'copy',
    title: '필요한 내용 담기',
    text: '다시 쓰고 싶은 노드를 복사해 두세요. 찾은 내용을 다음 생각의 출발점으로 삼을 수 있어요.',
  },
  {
    key: 'paste',
    title: '내 흐름에 옮기기',
    text: '복사한 노드를 캔버스에 붙여 넣고, 원하는 위치에 배치하세요.',
  },
  {
    key: 'edit',
    title: '내 말로 다듬기',
    text: '노드의 제목과 내용을 수정해, 내가 이해한 방식으로 정리하세요.',
  },
  {
    key: 'connect',
    title: '생각끼리 연결하기',
    text: '함께 보고 싶은 노드를 선으로 잇고, 연결에 이름을 붙여 보세요.',
  },
]
const faqs = [
  [
    'Rabbit Hole은 어떤 서비스인가요?',
    '질문과 답변을 하나의 캔버스에서 탐색하는 AI 서비스예요. 응답, 핵심 정보, 출처와 이미지를 각각의 노드로 살펴보고, 궁금한 지점에서 다음 질문을 이어 갈 수 있어요.',
  ],
  [
    '이미지나 파일로도 질문할 수 있나요?',
    '네. 입력창의 + 버튼에서 이미지나 파일을 첨부할 수 있어요. 웹 검색과 URL 접근도 질문에 맞춰 선택할 수 있습니다.',
  ],
  [
    '연결된 출처는 모두 답변의 근거인가요?',
    '출처를 조회한 것과 답변이 그 출처를 인용한 것은 구분해 표시해요. 노드 사이의 연결도 대화 순서나 정보의 관계에 따라 의미가 달라요. 궁금한 내용은 원문을 함께 확인해 주세요.',
  ],
  [
    '탐색한 내용을 다른 사람에게 보여 줄 수 있나요?',
    '공유 버튼을 누르면 현재 캔버스를 담은 링크가 복사돼요. 공유 페이지에서는 내용을 읽고 복사하거나 응답을 접어 볼 수 있습니다. HTML로 내려받거나 인쇄 화면에서 PDF로 저장할 수도 있어요.',
  ],
]

export function LandingPage() {
  const [preview, setPreview] = useState<{ key: ImageKey; alt: string } | null>(null)
  const [edit, setEdit] = useState(0)
  const previewTrigger = useRef<HTMLButtonElement | null>(null)
  function shot(key: ImageKey, alt: string, className = '') {
    return (
      <button
        type="button"
        className={`landing-shot ${className}`}
        onClick={(event) => {
          previewTrigger.current = event.currentTarget
          setPreview({ key, alt })
        }}
        aria-label={`${alt} 크게 보기`}
      >
        <img {...landingImages[key]} alt={alt} loading="lazy" decoding="async" />
        <span className="landing-zoom">
          <ZoomIn size={15} />
          크게 보기
        </span>
      </button>
    )
  }
  return (
    <div className="landing-page" id="top">
      <header className="landing-header">
        <a className="landing-brand" href="#top" aria-label="Rabbit Hole 처음으로">
          <RabbitIcon />
          <span>Rabbit Hole</span>
        </a>
        <nav aria-label="랜딩 페이지 탐색">
          <a href="#explore">호기심이 이어지는 곳</a>
          <a href="#features">주요 기능</a>
          <a href="#faq">자주 묻는 질문</a>
          <a className="landing-cta small" href="/">
            Rabbit Hole 시작하기 <ArrowUpRight size={16} />
          </a>
        </nav>
      </header>
      <main>
        <section className="landing-hero" aria-labelledby="landing-title">
          <span className="landing-doodle doodle-left">
            궁금한 것이
            <br />
            있나요?
            <svg viewBox="0 0 90 70" aria-hidden="true">
              <path d="M8 8Q64 0 64 53m-15-12 15 15 12-19" />
            </svg>
          </span>
          <div className="landing-hero-brand">
            <RabbitIcon />
            <span>Rabbit Hole</span>
          </div>
          <p className="landing-eyebrow">질문을 따라 넓어지는 AI 캔버스</p>
          <h1 id="landing-title">
            하나의 질문에서,
            <br />
            <em>다음 호기심으로.</em>
          </h1>
          <p className="landing-lead">
            답변을 읽고, 출처를 살피고, 떠오른 생각을 연결하세요.
            <br /> Rabbit Hole은 질문이 이어질수록 나만의 탐색 지도가 펼쳐지는 공간입니다.
          </p>
          <a className="landing-cta" href="/">
            내 호기심 따라가 보기 <ArrowRight size={18} />
          </a>
          <a className="landing-scroll" href="#explore">
            어떻게 탐색하나요? <ArrowDown size={15} />
          </a>
          <span className="landing-doodle doodle-right">
            질문이 생각으로
            <br />
            이어지는 새로운 방식
            <svg viewBox="0 0 100 65" aria-hidden="true">
              <path d="M80 4c-55 0-61 58-32 39S17 9 20 40q2 20 53 15m-12-9 15 9-15 8" />
            </svg>
          </span>
        </section>
        <div className="landing-stories">
          <section className="landing-story" id="explore">
            <div className="landing-visual mint">
              {shot('start', '예시 질문과 입력창으로 탐색을 시작하는 캔버스')}
              <span className="landing-note">시작은, 작은 궁금증 하나</span>
            </div>
            <div className="landing-copy">
              <span className="landing-number">01</span>
              <h2>
                잘 정리된 질문이
                <br />
                아니어도 괜찮아요.
              </h2>
              <p>
                문득 떠오른 궁금증을 적어 보세요.
                <br />
                어디서 시작할지 고민된다면 예시 질문을 골라 나만의 질문으로 바꿔도 좋아요.
              </p>
              <a href="/" className="landing-text-link">
                첫 질문 시작하기 <ArrowUpRight size={16} />
              </a>
            </div>
          </section>
          <section className="landing-story reverse" id="features">
            <div className="landing-visual blue">
              {shot('answer', '응답과 핵심 정보, 출처, 이미지가 연결된 탐색 결과')}
            </div>
            <div className="landing-copy">
              <span className="landing-number">02</span>
              <h2>
                답변 너머의 맥락까지,
                <br />
                한눈에 살펴보세요.
              </h2>
              <p>
                응답과 핵심 정보, 출처와 이미지가 각각의 노드로 펼쳐집니다. 필요한 내용을 가까이 보고, 원문을
                확인하며 이해를 넓혀 보세요.
              </p>
              <div className="landing-tags">
                <span>응답</span>
                <span>핵심 정보</span>
                <span>출처</span>
                <span>이미지</span>
              </div>
            </div>
          </section>
          <section className="landing-story follow-story">
            <div className="landing-visual lavender">
              {shot('branches', '이전 질문에서 새로운 질문으로 가지를 뻗은 캔버스')}
              {shot('follow', '선택한 노드의 내용을 바탕으로 이어서 질문하는 입력창', 'landing-inset')}
              <span className="landing-note">생각이 가지처럼 뻗어나가요</span>
            </div>
            <div className="landing-copy">
              <span className="landing-number">03</span>
              <h2>
                궁금한 지점에서
                <br />한 걸음 더.
              </h2>
              <p>
                답변 속에서 더 알고 싶은 내용을 발견했나요? 노드를 다음 응답에 활용해 질문을 이어 가세요. 앞선
                탐색을 옆에 둔 채, 새로운 방향으로 나아갈 수 있어요.
              </p>
            </div>
          </section>
          <section className="landing-tools" aria-labelledby="tools-title">
            <div className="landing-section-heading">
              <span className="landing-number">04</span>
              <h2 id="tools-title">
                궁금증의 시작은
                <br />
                글이 아니어도 좋아요.
              </h2>
              <p>
                이미지 한 장, 읽고 있던 문서, 살펴보고 싶은 링크.
                <br />
                내가 가진 자료에서 탐색을 시작하세요.
              </p>
            </div>
            <div className="landing-tools-grid">
              <div className="landing-tools-main">
                {shot('image', '첨부한 이미지를 분석하고 관련 정보로 확장한 답변')}
                <h3>사진을 보여 주고, 함께 들여다보기</h3>
                <p>
                  이미지에서 궁금한 점을 물어보세요. 첨부한 자료와 응답을 같은 캔버스에서 비교할 수 있어요.
                </p>
              </div>
              <div className="landing-tools-side">
                {shot('tools', '웹 검색, URL 접근, 파일과 이미지 첨부를 선택하는 도구 메뉴')}
                <h3>질문에 맞는 도구 고르기</h3>
                <p>웹을 찾아보거나 링크를 읽고, 파일과 이미지를 첨부해 질문에 맥락을 더하세요.</p>
                {shot('attach', '이미지를 첨부한 뒤 질문을 입력하는 모습')}
              </div>
            </div>
          </section>
          <section className="landing-edit" aria-labelledby="edit-title">
            <div className="landing-copy">
              <span className="landing-number">05</span>
              <h2 id="edit-title">
                찾은 정보를,
                <br />내 생각으로 정리하세요.
              </h2>
              <p>
                남겨 두고 싶은 내용은 옮기고 다듬어 보세요.
                <br />
                캔버스가 나만의 정리 공간이 됩니다.
              </p>
              <div className="landing-edit-tabs" aria-label="노드 활용 방법">
                {edits.map((item, i) => (
                  <button key={item.key} type="button" aria-pressed={edit === i} onClick={() => setEdit(i)}>
                    <span>0{i + 1}</span>
                    {item.title}
                    <ArrowRight size={16} />
                  </button>
                ))}
              </div>
            </div>
            <div className="landing-edit-preview">
              <div className="landing-edit-image">{shot(edits[edit].key, edits[edit].title)}</div>
              <p aria-live="polite">{edits[edit].text}</p>
            </div>
          </section>
          <section className="landing-story share-story">
            <div className="landing-visual peach">
              {shot('pdf', '노드 배치를 유지한 채 캔버스를 PDF로 저장하는 인쇄 화면')}
              {shot('share', '공유 링크와 다운로드를 여는 캔버스 도구', 'landing-share-toolbar')}
            </div>
            <div className="landing-copy">
              <span className="landing-number">06</span>
              <h2>
                탐색의 결과를
                <br />
                함께 나누세요.
              </h2>
              <p>
                지금의 캔버스를 링크 하나로 공유하세요. 노드의 배치를 살려 HTML이나 PDF로 보관하면, 탐색한
                흐름을 다시 꺼내 볼 수 있어요.
              </p>
              <div className="landing-tags">
                <span>공유 링크</span>
                <span>HTML</span>
                <span>PDF</span>
              </div>
            </div>
          </section>
          <section className="landing-faq" id="faq">
            <div>
              <span className="landing-eyebrow">조금 더 알아보기</span>
              <h2>
                궁금한 점이
                <br />
                남아 있나요?
              </h2>
            </div>
            <div>
              {faqs.map(([question, answer]) => (
                <details key={question}>
                  <summary>
                    {question}
                    <span aria-hidden="true">+</span>
                  </summary>
                  <p>{answer}</p>
                </details>
              ))}
            </div>
          </section>
        </div>
        <section className="landing-final">
          <RabbitIcon />
          <h2>이번엔, 당신의 호기심 차례.</h2>
          <p>어디로 이어질지는 첫 질문을 던져 보면 알 수 있어요.</p>
          <a className="landing-cta" href="/">
            Rabbit Hole 시작하기 <ArrowRight size={18} />
          </a>
        </section>
      </main>
      <footer className="landing-footer">
        <a className="landing-brand" href="#top">
          <RabbitIcon />
          <span>Rabbit Hole</span>
        </a>
        <span>호기심이 이어지는 곳</span>
        <a href="https://github.com/rabbitholechat/rabbit-hole" target="_blank" rel="noopener noreferrer">
          <Github size={17} />
          GitHub <ArrowUpRight size={14} />
        </a>
      </footer>
      {preview && (
        <ImagePreview
          image={preview}
          onClose={() => {
            setPreview(null)
            previewTrigger.current?.focus({ preventScroll: true })
          }}
        />
      )}
    </div>
  )
}
function ImagePreview({ image, onClose }: { image: { key: ImageKey; alt: string }; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const dismiss = () => {
    dialog.current?.close()
    onClose()
  }
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])
  return (
    <dialog
      className="landing-lightbox"
      ref={dialog}
      aria-label={image.alt}
      onCancel={(event) => {
        event.preventDefault()
        dismiss()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) dismiss()
      }}
    >
      <button type="button" onClick={dismiss} aria-label="이미지 닫기">
        <X size={22} />
      </button>
      <img {...landingImages[image.key]} alt={image.alt} />
      <p>{image.alt}</p>
    </dialog>
  )
}
