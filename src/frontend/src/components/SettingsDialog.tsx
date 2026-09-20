import { useEffect, useRef, useState } from 'react'
import { Github, Keyboard, LogOut, Settings, UserRound, X } from 'lucide-react'
import { RabbitIcon } from './RabbitIcon'
import { useStore } from '../store'

const shortcuts = [
  [
    '메시지',
    [
      ['메시지 보내기', 'Enter'],
      ['줄바꿈', 'Shift + Enter'],
    ],
  ],
  [
    '캔버스 탐색',
    [
      ['사이드바 열기 / 닫기', 'Ctrl / ⌘ + B'],
      ['이전 / 다음 노드', 'A / D'],
      ['확대 / 축소', 'W / S'],
      ['확대 / 축소', 'Ctrl / ⌘ + + / −'],
      ['화면 맞춤', 'Ctrl / ⌘ + 0'],
      ['상하 이동', '휠'],
      ['좌우 이동', 'Shift + 휠'],
      ['자유 이동', '트랙패드 / 빈 공간 드래그'],
      ['확대 / 축소', 'Ctrl + 휠'],
    ],
  ],
  [
    '노드 편집',
    [
      ['선택한 노드 복사', 'Ctrl / ⌘ + C'],
      ['노드 붙여넣기', 'Ctrl / ⌘ + V'],
      ['실행 취소', 'Ctrl / ⌘ + Z'],
      ['다시 실행', 'Ctrl / ⌘ + Shift + Z 또는 Y'],
      ['선택한 노드 / 연결 수정', 'F2 또는 Ctrl / ⌘ + E'],
      ['선택한 노드 / 연결 삭제', 'Delete 또는 Ctrl / ⌘ + Backspace'],
      ['편집 저장', 'Ctrl / ⌘ + Enter'],
      ['편집 / 메뉴 닫기', 'Esc'],
    ],
  ],
] as const

export function SidebarSettings() {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <>
      <footer className="sidebar-footer">
        <button ref={trigger} type="button" onClick={() => setOpen(true)}>
          <Settings size={17} />
          설정
        </button>
        <a
          href="https://github.com/rabbitholechat/rabbit-hole"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="GitHub (새 탭)"
        >
          <Github size={17} />
          GitHub
        </a>
      </footer>
      {open && (
        <SettingsDialog
          onClose={() => {
            setOpen(false)
            trigger.current?.focus()
          }}
        />
      )}
    </>
  )
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [section, setSection] = useState<'account' | 'shortcuts'>('account')
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])
  return (
    <dialog
      ref={dialog}
      className="settings-dialog"
      aria-labelledby="settings-title"
      onCancel={(event) => {
        event.preventDefault()
        dialog.current?.close()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const rect = event.currentTarget.getBoundingClientRect()
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onClose()
        }
      }}
    >
      <header className="settings-header">
        <h2 id="settings-title">설정</h2>
        <button type="button" aria-label="설정 닫기" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="설정 항목">
          <button type="button" aria-pressed={section === 'account'} onClick={() => setSection('account')}>
            <UserRound size={17} />
            계정
          </button>
          <button
            type="button"
            aria-pressed={section === 'shortcuts'}
            onClick={() => setSection('shortcuts')}
          >
            <Keyboard size={17} />
            단축키
          </button>
        </nav>
        <section
          className="settings-content"
          aria-label={section === 'account' ? '계정 설정' : '단축키 안내'}
        >
          {section === 'account' ? (
            <>
              <h3>계정</h3>
              <div className="settings-profile">
                <div className="settings-avatar">
                  <RabbitIcon />
                </div>
                <div>
                  <strong>Rabbit</strong>
                  <p>데모 계정</p>
                </div>
              </div>
              <button
                className="settings-logout"
                type="button"
                onClick={() => {
                  useStore.getState().newConversation()
                  window.location.assign('/landing')
                }}
              >
                <LogOut size={17} />
                로그아웃
              </button>
            </>
          ) : (
            <>
              <h3>단축키</h3>
              <p className="settings-hint">
                캔버스 단축키는 입력창 밖에서 사용할 수 있습니다. 노드 편집은 대화 화면에서 지원합니다.
              </p>
              {shortcuts.map(([title, entries]) => (
                <section className="shortcut-group" key={title}>
                  <h4>{title}</h4>
                  <dl>
                    {entries.map(([label, keys]) => (
                      <div key={`${label}-${keys}`}>
                        <dt>{label}</dt>
                        <dd>
                          <kbd>{keys}</kbd>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </>
          )}
        </section>
      </div>
    </dialog>
  )
}

// Landing design is intentionally deferred to the next task.
export function LandingPlaceholder() {
  return (
    <main className="landing-placeholder">
      <div className="welcome-brand">
        <RabbitIcon />
        <span>Rabbit Hole</span>
      </div>
      <p>로그아웃되었습니다</p>
      <a href="/">데모 시작하기</a>
    </main>
  )
}
