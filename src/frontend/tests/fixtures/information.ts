import type { CardPresentation, GroundedText, StructureResult, TextSpan } from '../../src/types'

export const structuredAnswer = '🐇 A는 설치가 간단하고 사용자 정의가 제한적입니다. [A](https://example.com/a)\n별도 참고 [무관한 자료](https://example.com/unrelated)\nB는 초기 설정이 복잡하지만 사용자 정의가 가능합니다. [B](https://example.com/b)\n설치 후 설정을 입력하고 실행합니다. 설정 전에는 실행하지 마세요.'
const lines = structuredAnswer.split('\n')
export const lineSpan = (line: number): TextSpan => {
  const start = Array.from(lines.slice(0, line).join('\n')).length + (line ? 1 : 0)
  return { start, end: start + Array.from(lines[line]).length, quote: lines[line] }
}
const value = (text: string, ...lines: number[]): GroundedText => ({ text, references: lines.map(lineSpan) })
export function structuredResult(hash: string): StructureResult {
  const comparison: CardPresentation = {
    heading: 'A와 B의 차이', summary: null, sections: [],
    table: { columns: [value('비교 기준', 0, 2), value('A', 0), value('B', 2)], rows: [
      [value('설치·설정', 0, 2), value('설치가 간단함', 0), value('초기 설정이 복잡함', 2)],
      [value('사용자 정의', 0, 2), value('제한적', 0), value('가능', 2)],
    ] },
  }
  const procedure: CardPresentation = {
    heading: '설치부터 실행까지', summary: null, table: null,
    sections: [
      { heading: null, layout: 'steps', items: [value('설치합니다.', 3), value('설정을 입력합니다.', 3), value('실행합니다.', 3)] },
      { heading: '실행 전 확인', layout: 'bullets', items: [value('설정 전에는 실행하지 마세요.', 3)] },
    ],
  }
  return { version: 2, text_hash: hash, items: [comparison, procedure].map((presentation, index) => ({
    key: (index ? 'e' : 'd').repeat(24), subtype: index ? 'procedure' : 'comparison',
    title: lineSpan(index ? 3 : 0), excerpt: lineSpan(index ? 3 : 0), presentation,
  })) }
}
