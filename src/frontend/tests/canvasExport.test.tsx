import { afterEach, expect, it } from 'vitest'
import { canvasHtml } from '../src/lib/canvasExport'
import { entitySession } from './fixtures/entities'

afterEach(() => {
  document.body.innerHTML = ''
})
it('preserves canvas positions, rendered cards and SVG edges without embedding app context', () => {
  const session = entitySession()
  session.title = '<script>alert(1)</script>'
  session.continuation = 'signed-context'
  session.nodes[0].position = { x: -100, y: 200 }
  document.body.innerHTML = `<div class="react-flow__viewport" style="transform:translate(20px,40px) scale(.5)"><svg><defs><marker id="arrow#color"></marker></defs><path d="M0 0 L100 100" style="marker-end:url('http://localhost/#arrow#color')" /></svg><div class="react-flow__node" data-id="response_entity" style="transform:translate(-100px,200px)"><article style="background-color:rgb(234,247,243)"><h2>사용자 질문</h2><p>답변 내용</p><a href="javascript:alert(1)">링크</a><div class="response-actions"><button onclick="alert(1)">복사</button><button>펼치기</button><button>삭제하기</button></div><div class="previous-node"><button>이전 노드로</button></div><button class="node-button">관련 정보로</button><ul class="entity-information"><li><button>보존할 정보 제목</button></li></ul></article></div></div>`
  const html = canvasHtml(session)
  const output = new DOMParser().parseFromString(html, 'text/html')
  expect(output.querySelectorAll('.react-flow__node')).toHaveLength(1)
  expect(output.querySelector('.react-flow__node')?.getAttribute('style')).toContain(
    'translate(-100px,200px)',
  )
  expect(output.querySelector('article')?.getAttribute('style')).toContain('rgb(234, 247, 243)')
  expect(output.querySelector('path')?.getAttribute('style')).toContain('url(#arrow#color)')
  expect(
    output.querySelectorAll('article button, .response-actions, .previous-node, .node-button'),
  ).toHaveLength(0)
  expect(output.querySelector('.entity-information')?.textContent).toBe('보존할 정보 제목')
  expect(output.querySelector('article')?.textContent).not.toMatch(
    /복사|펼치기|삭제하기|이전 노드로|관련 정보로/,
  )
  expect(document.querySelectorAll('.response-actions button')).toHaveLength(3)
  expect(output.querySelector('a')?.hasAttribute('href')).toBe(false)
  expect(output.title).toBe(session.title)
  expect(html).not.toContain('signed-context')
  expect(html).toContain('@page{size:')
})
it('does not silently substitute a text document when the canvas is unavailable', () => {
  expect(() => canvasHtml(entitySession())).toThrow('캔버스가 준비되지 않았습니다.')
})
