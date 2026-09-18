import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { InformationContent } from '../src/components/InformationContent'
import { structuredResult } from './fixtures/information'

it('renders generated text safely and preserves missing cells without original-text controls', () => {
  const card = structuredResult('hash').items[0].presentation!
  card.table!.rows[0][1]!.text = '<img src=x onerror=alert(1)> [링크](https://example.com)'
  card.table!.rows[1][2] = null
  const { container } = render(<InformationContent card={card} />)
  expect(container.querySelectorAll('img, a, script')).toHaveLength(0)
  expect(screen.getByText('<img src=x onerror=alert(1)> [링크](https://example.com)')).toBeInTheDocument()
  expect(screen.getByLabelText('답변에 정보 없음')).toHaveTextContent('—')
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
