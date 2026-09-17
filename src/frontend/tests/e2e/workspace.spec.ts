import { test, expect, type Page } from '@playwright/test'
async function openHistory(page: Page) {
  const expand = page.getByRole('button', { name: '검색 기록 펼치기' })
  if (await expand.isVisible()) await expand.click()
}
async function sample(page: Page) {
  await openHistory(page)
  await page.getByRole('button', { name: '디자인 예시 둘러보기' }).click()
  await page.getByRole('button', { name: '벡터 검색이란? 가상 데이터' }).click()
}
test('same canvas, suggestion only fills, samples, selection, relation, history restore and delete', async ({
  page,
}) => {
  let calls = 0
  page.on('request', (request) => {
    if (request.url().includes('/api/search')) calls++
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '호기심이 이어지는 곳' })).toBeVisible()
  await page.getByRole('button', { name: '벡터 검색이란?', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '검색 질문' })).toHaveValue('벡터 검색이란?')
  expect(calls).toBe(0)
  await page.locator('.react-flow').evaluate((el) => el.setAttribute('data-original-canvas', 'yes'))
  await sample(page)
  await expect(page.locator('.page-card')).toHaveCount(6)
  await expect(page.locator('.react-flow')).toHaveAttribute('data-original-canvas', 'yes')
  await expect(page.locator('.sample-badge')).toHaveText('디자인 예시 · 가상 데이터')
  await page.getByRole('button', { name: '답변 펼치기' }).click()
  await page.getByRole('button', { name: '출처 1 선택' }).click()
  await expect(page.getByRole('region', { name: '출처 상세' })).toBeVisible()
  await page.getByRole('button', { name: '상세 닫기' }).click()
  await page.getByRole('button', { name: '답변 접기' }).click()
  await page.locator('.edge-label').first().click({ force: true })
  await expect(page.getByRole('region', { name: '관계 상세' })).toBeVisible()
  await page.getByRole('button', { name: '상세 닫기' }).click()
  await page.reload()
  await openHistory(page)
  await page.getByRole('button', { name: '벡터 검색이란? 예시', exact: true }).click()
  await expect(page.locator('.page-card')).toHaveCount(6)
  expect(calls).toBe(0)
  await openHistory(page)
  await page.getByRole('button', { name: '벡터 검색이란? 기록 삭제' }).click()
  await expect(page.locator('.page-card')).toHaveCount(0)
  await expect(page.getByText('검색 기록이 여기에 쌓입니다.')).toBeVisible()
})
test('IME Enter does not submit, failed API never silently loads a sample', async ({ page }) => {
  let calls = 0
  await page.route('**/api/search', async (route) => {
    calls++
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ detail: '검색 API 키를 설정하세요.' }),
    })
  })
  await page.goto('/')
  const input = page.getByRole('textbox', { name: '검색 질문' })
  await input.fill('벡터 검색')
  await input.dispatchEvent('compositionstart')
  await input.press('Enter')
  expect(calls).toBe(0)
  await input.dispatchEvent('compositionend')
  await page.getByRole('button', { name: '검색 실행' }).click()
  await expect(page.getByRole('alert')).toContainText('검색 API 키를 설정하세요.')
  await expect(page.locator('.page-card')).toHaveCount(0)
  await expect(page.locator('.sample-badge')).toHaveCount(0)
})
for (const query of ['오사카 항공권 비교', '팀에 맞는 검색 시스템 비교']) {
  test(`model clarification uses the same UI and resumes without extra calls: ${query}`, async ({ page }) => {
    let calls = 0
    await page.route('**/api/search', async (route) => {
      const body = route.request().postDataJSON()
      calls++
      expect(body).not.toHaveProperty('flight')
      let seq = 0
      const ev = (type: string, data: object) =>
        `data: ${JSON.stringify({ version: 1, request_id: body.request_id, job_id: 'j', seq: ++seq, type, data })}\n\n`
      if (calls === 1) {
        expect(body.query).toBe(query)
        await route.fulfill({
          contentType: 'text/event-stream',
          body:
            ev('clarification', {
              message: '비교 기준을 알려주세요.',
              questions: ['가장 중요한 조건은 무엇인가요?'],
              suggestions: ['비용을 우선해 주세요', '특별한 선호는 없어요'],
            }) +
            ev('checkpoint', { continuation: 'signed-clarification' }) +
            ev('done', { status: 'awaiting_input', failed_parts: [] }),
        })
      } else {
        expect(body.query).toBe('비용을 우선하고 다른 조건은 자유롭게 비교해 주세요')
        expect(body.continuation).toBe('signed-clarification')
        await route.fulfill({
          contentType: 'text/event-stream',
          body:
            ev('answer', { claims: [], limitation: '조건을 반영했습니다.' }) +
            ev('done', { status: 'completed', failed_parts: [] }),
        })
      }
    })
    await page.goto('/')
    await page.getByRole('textbox', { name: '검색 질문' }).fill(query)
    await page.getByRole('button', { name: '검색 실행' }).click()
    await expect(page.getByRole('region', { name: '추가 질문' })).toContainText(
      '가장 중요한 조건은 무엇인가요?',
    )
    await expect(page.getByText('추가 답변을 기다리고 있어요')).toBeVisible()
    await expect(page.locator('input[type="date"], select')).toHaveCount(0)
    await page.getByRole('button', { name: '비용을 우선해 주세요', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '검색 질문' })).toHaveValue('비용을 우선해 주세요')
    expect(calls).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.reload()
    await openHistory(page)
    await page.getByRole('button', { name: query, exact: true }).click()
    await expect(page.getByRole('region', { name: '추가 질문' })).toBeVisible()
    expect(calls).toBe(1)
    await page
      .getByRole('textbox', { name: '검색 질문' })
      .fill('비용을 우선하고 다른 조건은 자유롭게 비교해 주세요')
    await page.getByRole('button', { name: '검색 실행' }).click()
    await expect(page.getByRole('region', { name: '추가 질문' })).toHaveCount(0)
    expect(calls).toBe(2)
  })
}

test('live SSE cards, original link and expansion preserve positions and viewport', async ({ page }) => {
  const sources = [1, 2, 3].map((i) => ({
    id: `src_test_${i}`,
    original_url: `https://example.com/page-${i}`,
    url: `https://example.com/page-${i}`,
    domain: 'example.com',
    title: `검증 페이지 ${i}`,
    summary: `페이지 ${i}의 검증된 검색 요약입니다.`,
    excerpt: '',
    published_at: null,
    retrieved_at: '2026-09-16T12:00:00Z',
    read_status: 'summary',
    tag: '웹페이지',
  }))
  let count = 0
  await page.route('**/api/search', async (route) => {
    const body = route.request().postDataJSON()
    count++
    if (count === 2) {
      expect(body.continuation).toBe('signed-test-checkpoint')
      expect(body.focus_source_id).toBe(sources[0].id)
    }
    let seq = 0
    const ev = (type: string, data: object) =>
      `data: ${JSON.stringify({ version: 1, request_id: body.request_id, job_id: 'job-test', seq: ++seq, type, data })}\n\n`
    await route.fulfill({
      contentType: 'text/event-stream',
      body:
        ev('started', { access_token: 'test-only-token' }) +
        ev('sources', { sources: count === 1 ? sources.slice(0, 2) : sources }) +
        ev('part_error', { part: 'relationships', message: '관계만 다시 정리할 수 있습니다.' }) +
        ev('checkpoint', { continuation: 'signed-test-checkpoint' }) +
        ev('done', { status: 'partial', failed_parts: ['relationships'] }),
    })
  })
  await page.goto('/')
  await page.getByRole('textbox', { name: '검색 질문' }).fill('페이지 비교')
  await page.getByRole('button', { name: '검색 실행' }).click()
  await expect(page.locator('.page-card')).toHaveCount(2)
  await expect(page.getByRole('button', { name: '관계 재시도' })).toBeVisible()
  await page.getByRole('button', { name: '오류 안내 닫기' }).click()
  await expect(page.locator('.react-flow__viewport')).not.toHaveAttribute(
    'style',
    'transform: translate(0px, 0px) scale(1);',
  )
  const card = page.locator('[data-id="src_test_1"]')
  await card.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('region', { name: '출처 상세' })).toBeVisible()
  await expect(page.getByRole('link', { name: '원문 열기', exact: true })).toHaveAttribute(
    'href',
    'https://example.com/page-1',
  )
  const before = await card.getAttribute('style')
  // Wait for the initial fit transition to settle before comparing viewport transforms.
  await expect.poll(async () => page.locator('.canvas-tools span').innerText()).not.toBe('100%')
  const viewportBefore = await page.locator('.react-flow__viewport').getAttribute('style')
  await page.getByRole('button', { name: '관련 자료 더 찾기' }).click()
  await expect(page.locator('.page-card')).toHaveCount(3)
  await expect(card).toHaveAttribute('style', before!)
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style', viewportBefore!)
  await expect(page.locator('.sample-badge')).toHaveCount(0)
  expect(count).toBe(2)
})

test('cancelling then opening a new canvas ignores a late old response', async ({ page }) => {
  let finish: (() => void) | undefined
  await page.route('**/api/search', async (route) => {
    const body = route.request().postDataJSON()
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    await route
      .fulfill({
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ version: 1, request_id: body.request_id, job_id: 'late', seq: 1, type: 'answer', data: { claims: [], limitation: 'old answer' } })}\n\n`,
      })
      .catch(() => {})
  })
  await page.goto('/')
  await page.getByRole('textbox', { name: '검색 질문' }).fill('오래 걸리는 검색')
  await page.getByRole('button', { name: '검색 실행' }).click()
  await expect(page.getByRole('button', { name: '검색 중지' })).toBeVisible()
  await expect.poll(() => Boolean(finish)).toBe(true)
  await page.getByRole('button', { name: '검색 중지' }).click()
  await openHistory(page)
  await page.getByRole('button', { name: '새 검색', exact: true }).click()
  finish!()
  await expect(page.getByRole('heading', { name: '호기심이 이어지는 곳' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'AI 답변' })).toHaveCount(0)
  await expect(page.locator('.page-card')).toHaveCount(0)
})
