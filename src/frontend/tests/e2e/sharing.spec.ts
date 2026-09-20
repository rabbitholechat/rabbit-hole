import { test, expect } from '@playwright/test'
import { entitySession } from '../fixtures/entities'
import type { Session } from '../../src/types'

function snapshot() {
  const session = entitySession()
  session.viewport = { x: 35, y: 155, zoom: 0.55 }
  if (session.nodes[0].type === 'response') {
    session.nodes[0].data.text = Array.from(
      { length: 35 },
      (_, i) =>
        `### 섹션 ${i + 1}\n\n한글 답변과 조건, 예외를 보존합니다.\n\n| 항목 | 설명 |\n|---|---|\n| 조건 | 원문 유지 |`,
    ).join('\n\n')
    session.nodes[0].data.collapsed = true
  }
  session.nodes.push({
    id: 'response_next',
    type: 'response',
    position: { x: 700, y: 100 },
    width: 560,
    data: {
      prompt: '다음 질문',
      text: '노드 위치와 연결선 유지',
      status: 'completed',
      parentId: 'response_entity',
    },
  })
  return session
}

test('share snapshots and exports the current canvas; shared view never writes or calls models', async ({
  page,
  context,
}, testInfo) => {
  const original = snapshot()
  let shared: Session | undefined
  let copied = ''
  let forbidden = 0
  await context.exposeFunction('captureCopy', (text: string) => {
    copied = text
  })
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: (text: string) =>
          (window as unknown as { captureCopy: (text: string) => Promise<void> }).captureCopy(text),
      },
    })
    window.print = () => {
      document.body.dataset.printed = 'true'
    }
  })
  await context.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/shares' && route.request().method() === 'POST') {
      shared = route.request().postDataJSON()
      return route.fulfill({ status: 201, json: { id: 'snapshot-id' } })
    }
    if (path === '/api/shares/snapshot-id') return route.fulfill({ json: { session: shared } })
    if (route.request().method() === 'GET' && path.startsWith('/api/sessions'))
      return route.fulfill({
        json:
          path === '/api/sessions'
            ? { sessions: [{ session: original, revision: 1 }] }
            : { session: original, revision: 1 },
      })
    if (path.startsWith('/api/sessions') && route.request().method() === 'PUT')
      return route.fulfill({ json: { revision: 2 } })
    forbidden++
    return route.abort()
  })
  await page.goto('/')
  const expand = page.getByRole('button', { name: '대화 기록 펼치기' })
  if (await expand.isVisible()) await expand.click()
  await page.getByRole('button', { name: original.query, exact: true }).click()
  const close = page.getByRole('button', { name: '대화 기록 접기' })
  if (await close.isVisible()) await close.click()
  await page.getByRole('button', { name: '공유', exact: true }).click()
  await expect(page.locator('.action-toast')).toHaveText('공유 링크를 복사했습니다')
  expect(copied).toContain('/share/snapshot-id')
  expect(shared?.nodes[0].data).toEqual(original.nodes[0].data)
  await expect(
    page.getByRole('dialog', { name: '공유 링크' }).getByRole('button', { name: '닫기' }),
  ).toHaveCount(0)
  copied = ''
  await page
    .getByRole('dialog', { name: '공유 링크' })
    .getByRole('button', { name: '복사하기', exact: true })
    .click()
  expect(copied).toContain('/share/snapshot-id')
  await page.screenshot({ path: testInfo.outputPath('share-popup.png') })
  await page.getByRole('button', { name: '다운로드', exact: true }).click()
  await page.screenshot({ path: testInfo.outputPath('download-menu.png') })
  const downloading = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: 'HTML 다운로드' }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toMatch(/\.html$/)
  await download.saveAs(testInfo.outputPath('canvas.html'))
  await page.getByRole('button', { name: '다운로드', exact: true }).click()
  const opened = page.waitForEvent('popup')
  await page.getByRole('menuitem', { name: 'PDF로 저장' }).click()
  const exportPage = await opened
  await expect(exportPage.locator('.react-flow__node')).toHaveCount(2)
  await expect(exportPage.locator('.react-flow__edge')).toHaveCount(1)
  await expect(exportPage.locator('.react-flow__node button, .response-actions, .previous-node')).toHaveCount(
    0,
  )
  await expect(exportPage.getByText('노드 위치와 연결선 유지')).toBeVisible()
  await expect(exportPage.locator('[data-id="response_next"]')).toHaveCSS(
    'transform',
    'matrix(1, 0, 0, 1, 700, 100)',
  )
  await expect(exportPage.locator('body')).toHaveAttribute('data-printed', 'true')
  await exportPage.screenshot({ path: testInfo.outputPath('print-document.png') })
  if (testInfo.project.name === 'desktop')
    await exportPage.pdf({ path: testInfo.outputPath('canvas.pdf'), preferCSSPageSize: true })
  await exportPage.close()

  const reader = await context.newPage()
  const writes: string[] = []
  await reader.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/shares/snapshot-id' && route.request().method() === 'GET')
      return route.fulfill({ json: { session: shared } })
    writes.push(path)
    return route.abort()
  })
  await reader.goto('/share/snapshot-id')
  await expect(reader.getByText('공유 · 읽기 전용')).toBeVisible()
  await expect(reader.locator('.brand svg')).toBeVisible()
  await expect(reader.locator('.brand span')).toHaveText('Rabbit Hole')
  await expect(reader.getByRole('textbox', { name: '메시지 입력' })).toHaveCount(0)
  for (const name of ['수정하기', '삭제하기', '이어서 질문하기', '다음 응답에 사용', '구조화', '실행 취소']) {
    await expect(reader.getByRole('button', { name, exact: true })).toHaveCount(0)
  }
  await reader.getByRole('button', { name: '응답 확장', exact: true }).click()
  await expect(reader.getByRole('button', { name: '응답 접기', exact: true }).first()).toBeVisible()
  await reader.getByRole('button', { name: '복사하기', exact: true }).first().click()
  expect(copied).toContain('섹션 35')
  await reader.getByRole('button', { name: '축소', exact: true }).click()
  await reader.screenshot({ path: testInfo.outputPath('shared-canvas.png') })
  await reader.reload()
  await expect(reader.getByRole('button', { name: '응답 확장', exact: true })).toBeVisible()
  expect(writes).toEqual([])
  expect(forbidden).toBe(0)
})

test('shared links fail explicitly without loading unrelated history', async ({ page }) => {
  const requests: string[] = []
  await page.route('**/api/**', (route) => {
    requests.push(new URL(route.request().url()).pathname)
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto('/share/missing')
  await expect(page.getByRole('alert')).toHaveText('공유 캔버스를 찾을 수 없습니다.')
  await expect(page.getByRole('textbox', { name: '메시지 입력' })).toHaveCount(0)
  expect(requests.every((path) => path === '/api/shares/missing')).toBe(true)
})
