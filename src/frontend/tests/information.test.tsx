import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { InformationContent } from '../src/components/InformationContent'
import { structuredResult } from './fixtures/information'

it('renders generated text safely, preserves missing cells, and discloses exact original passages', () => {
  // jsdom lacks the native dialog API; browser tests exercise the real modal.
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  const card = structuredResult('hash').items[0].presentation!
  card.table!.rows[0][1]!.text = '<img src=x onerror=alert(1)> [링크](https://example.com)'
  card.table!.rows[1][2] = null
  const { container } = render(<InformationContent card={card} />)
  expect(container.querySelectorAll('img, a, script')).toHaveLength(0)
  expect(screen.getByText('<img src=x onerror=alert(1)> [링크](https://example.com)')).toBeInTheDocument()
  expect(screen.getByLabelText('답변에 정보 없음')).toHaveTextContent('—')
  const toggle = screen.getByLabelText('원문 보기: <img src=x onerror=alert(1)> [링크](https://example.com)')
  fireEvent.click(toggle)
  const dialog = screen.getByRole('dialog', { name: '답변 원문' })
  expect(dialog).toHaveAttribute('open')
  expect(dialog.querySelector('blockquote')).toHaveTextContent('🐇 A는 설치가 간단하고 사용자 정의가 제한적입니다.')
  fireEvent.click(screen.getByRole('button', { name: '닫기' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
})
