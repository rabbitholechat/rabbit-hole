import type { CardPresentation, GroundedText, TextSpan } from '../types'

export function cardValues(card: CardPresentation): GroundedText[] {
  return [
    ...(card.summary ? [card.summary] : []),
    ...card.sections.flatMap((section) => section.items),
    ...(card.table ? [...card.table.columns, ...card.table.rows.flatMap((row) => row.filter((cell): cell is GroundedText => cell !== null))] : []),
  ]
}
export function cardReferences(card: CardPresentation): TextSpan[] {
  return [...new Map(cardValues(card).flatMap((value) => value.references).map((ref) => [`${ref.start}:${ref.end}`, ref])).values()]
}
export function cardText(card: CardPresentation): string {
  return [card.heading, card.summary?.text,
    ...card.sections.flatMap((section) => [section.heading, ...section.items.map((item, index) =>
      `${section.layout === 'steps' ? `${index + 1}. ` : section.layout === 'bullets' ? '- ' : ''}${item.text}`)]),
    ...(card.table ? [card.table.columns.map((col) => col.text).join(' | '),
      ...card.table.rows.map((row) => row.map((cell) => cell?.text ?? '—').join(' | '))] : []),
  ].filter(Boolean).join('\n')
}

// Treat API content as untrusted even when TypeScript knows its declared shape.
export function validPresentation(value: unknown, checkSpan: (span: TextSpan, max: number) => boolean): value is CardPresentation {
  if (!value || typeof value !== 'object') return false
  const card = value as CardPresentation
  const string = (text: unknown, max: number): text is string =>
    typeof text === 'string' && text.trim().length > 0 && Array.from(text).length <= max
  const grounded = (item: GroundedText | null): item is GroundedText => Boolean(item &&
    string(item.text, 800) && Array.isArray(item.references) && item.references.length >= 1 && item.references.length <= 4 &&
    item.references.every((ref) => checkSpan(ref, 6000)))
  if (!string(card.heading, 100) || (card.summary !== null && !grounded(card.summary)) ||
    !Array.isArray(card.sections) || card.sections.length > 4 || !card.sections.every((section) =>
      section && (section.heading === null || string(section.heading, 80)) && ['text', 'bullets', 'steps'].includes(section.layout) &&
      Array.isArray(section.items) && section.items.length >= 1 && section.items.length <= 8 && section.items.every(grounded))) return false
  if (card.table !== null) {
    const table = card.table
    if (!table || !Array.isArray(table.columns) || table.columns.length < 2 || table.columns.length > 5 || !table.columns.every(grounded) ||
      !Array.isArray(table.rows) || table.rows.length < 1 || table.rows.length > 8 || !table.rows.every((row) =>
        Array.isArray(row) && row.length === table.columns.length && row.some((cell) => cell !== null) &&
        row.every((cell) => cell === null || grounded(cell)))) return false
  }
  const values = cardValues(card)
  return values.length > 0 && Array.from(card.heading + card.sections.map((section) => section.heading ?? '').join('') +
    values.map((item) => item.text).join('')).length <= 6000
}
