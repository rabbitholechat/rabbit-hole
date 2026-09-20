import { test, expect } from '@playwright/test'
import { memoryHistoryApi } from '../fixtures/historyApi'

test('landing explains the product, previews real screenshots and opens the canvas', async ({
  page,
}, testInfo) => {
  const apiRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/')) apiRequests.push(request.url())
  })
  await page.goto('/landing')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('하나의 질문에서,다음 호기심으로.')
  await expect(page.locator('.landing-hero-brand svg')).toBeVisible()
  await expect(page.locator('.react-flow')).toHaveCount(0)
  const before = await page.locator('.landing-hero').boundingBox()
  expect(before!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  await page.screenshot({ path: testInfo.outputPath('landing-top.png') })
  const nav = page.getByRole('navigation', { name: '랜딩 페이지 탐색' })
  await expect(nav.getByRole('link', { name: '호기심이 이어지는 곳' })).toHaveCount(0)
  await expect(page.locator('.landing-doodle')).toHaveCount(0)
  await expect(page.locator('html')).toHaveCSS('scroll-behavior', 'smooth')
  await nav.getByRole('link', { name: '조금 더 알아보기', exact: true }).click()
  await expect(page).toHaveURL(/#faq$/)
  await expect
    .poll(() => page.locator('#faq').evaluate((el) => Math.abs(el.getBoundingClientRect().top - 30)))
    .toBeLessThan(3)
  const models = page.locator('details').filter({ hasText: '어떤 AI 모델을 사용하나요?' })
  await models.locator('summary').click()
  await expect(models.locator('p')).toContainText('gpt-5.4-mini')
  await expect(models.locator('p')).toContainText('gpt-4o-mini')
  await expect(models.locator('p')).toContainText('모델을 따로 선택하지 않습니다')

  for (const title of ['필요한 내용 담기', '내 흐름에 옮기기', '내 말로 다듬기', '생각끼리 연결하기']) {
    await page
      .locator('.landing-edit-tabs')
      .getByRole('button', { name: new RegExp(title) })
      .click()
    await expect(page.getByRole('button', { name: `${title} 크게 보기`, exact: true })).toBeVisible()
  }
  const shot = page.getByRole('button', { name: '생각끼리 연결하기 크게 보기', exact: true })
  await shot.click()
  const preview = page.getByRole('dialog', { name: '생각끼리 연결하기' })
  await expect(preview).toBeVisible()
  await expect(preview.locator('img')).toHaveJSProperty('complete', true)
  await page.keyboard.press('Escape')
  await expect(preview).toHaveCount(0)
  await expect(shot).toBeFocused()
  await page.locator('summary').filter({ hasText: '이미지나 파일로도 질문할 수 있나요?' }).click()
  await expect(
    page.locator('details[open]').filter({ hasText: '이미지나 파일로도 질문할 수 있나요?' }),
  ).toContainText('입력창의 + 버튼')
  for (const img of await page.locator('.landing-shot img').all()) {
    await img.scrollIntoViewIfNeeded()
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  )
  await page.screenshot({ path: testInfo.outputPath('landing-full.png'), fullPage: true })
  await page.setViewportSize({ width: 320, height: 740 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
  const headerStart = page.locator('.landing-header .landing-cta')
  const headerBox = (await headerStart.boundingBox())!
  expect(headerBox.x + headerBox.width).toBeLessThanOrEqual(320)
  expect(apiRequests).toEqual([])
  const start = page.getByRole('link', { name: '내 호기심 따라가 보기', exact: true })
  await expect(start).toHaveAttribute('href', '/')
  await page.route('**/api/sessions**', async (route) =>
    route.fulfill({ json: await memoryHistoryApi().list() }),
  )
  await start.click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('textbox', { name: '메시지 입력' })).toBeVisible()
})
