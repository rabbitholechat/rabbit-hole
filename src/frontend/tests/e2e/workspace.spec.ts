import { test, expect, type Page } from '@playwright/test'
async function openHistory(page: Page) {
  const expand = page.getByRole('button', { name: '대화 기록 펼치기' })
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
    if (request.url().includes('/api/agent')) calls++
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '호기심이 이어지는 곳' })).toBeVisible()
  await page.getByRole('button', { name: '복잡한 개념을 쉽게 설명해줘', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '메시지 입력' })).toHaveValue('복잡한 개념을 쉽게 설명해줘')
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
  await expect(page.getByText('대화 기록이 여기에 쌓입니다.')).toBeVisible()
})

test('IME submission and unconfigured agent show an error without sample fallback', async ({ page }) => {
  let calls = 0
  await page.route('**/api/agent', async (route) => {
    calls++
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ detail: '모델 API 키를 설정하세요.' }),
    })
  })
  await page.goto('/')
  const input = page.getByRole('textbox', { name: '메시지 입력' })
  await input.fill('설명해줘')
  await input.dispatchEvent('compositionstart')
  await input.press('Enter')
  expect(calls).toBe(0)
  await input.dispatchEvent('compositionend')
  await page.getByRole('button', { name: '메시지 보내기' }).click()
  await expect(page.getByRole('alert')).toContainText('모델 API 키')
  await expect(page.locator('.page-card, .response-card')).toHaveCount(0)
})

// A controllable browser stream proves the first delta is visible before completion.
async function installStream(page: Page) {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window)
    const harness = { calls: [] as Record<string, unknown>[], finish: () => {} }
    Object.assign(window, { agentHarness: harness })
    window.fetch = async (input, init) => {
      if (input !== '/api/agent') return original(input, init)
      const request = JSON.parse(init!.body as string)
      harness.calls.push(request)
      const id = `response_${request.request_id}`
      let seq = 0
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream({
          start(controller) {
            const emit = (type: string, data: object) =>
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ version: 2, request_id: request.request_id, job_id: 'j', seq: ++seq, type, data })}\n\n`,
                ),
              )
            emit('started', { access_token: 'test-token' })
            emit('checkpoint', { continuation: 'before-turn' })
            emit('response_started', { id })
            emit('response_delta', { id, delta: '**첫 번째 응답**\n\n' })
            harness.finish = () => {
              emit('response_delta', { id, delta: '후속 문장입니다.' })
              emit('response_completed', { id, text: '**첫 번째 응답**\n\n후속 문장입니다.' })
              emit('checkpoint', { continuation: 'completed-turn' })
              emit('done', { status: 'completed', failed_parts: [] })
              controller.close()
            }
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      )
    }
  })
}
const finishStream = (page: Page) =>
  page.evaluate(() => (window as unknown as { agentHarness: { finish: () => void } }).agentHarness.finish())
const calls = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { agentHarness: { calls: Record<string, unknown>[] } }).agentHarness.calls,
  )

test('streams into a canvas node, retains dragged placement, continues conversation and restores offline', async ({
  page,
}) => {
  await installStream(page)
  await page.goto('/')
  await page.getByRole('textbox', { name: '메시지 입력' }).fill('실행 계획을 정리해줘')
  await page.getByRole('button', { name: '메시지 보내기' }).click()
  const card = page.locator('.response-card').first()
  await expect(card.locator('strong')).toHaveText('첫 번째 응답')
  await expect(card.getByRole('button', { name: '응답 접기' })).toBeDisabled()
  await expect(card).toHaveAttribute('aria-busy', 'true')
  await expect(card.locator('.response-status')).toHaveText('응답 중')
  await expect(card.locator('.response-status .spin')).toBeVisible()
  await expect(page.getByRole('button', { name: '응답 중지' })).toBeVisible()
  const node = page.locator('.react-flow__node-response').first()
  await expect.poll(() => page.locator('.canvas-tools span').innerText()).not.toBe('100%')
  await node.focus()
  await page.keyboard.press('ArrowRight')
  await expect(card.locator('.node-tag')).toHaveText('응답')
  await expect(card).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(node.locator('.react-flow__handle').first()).toHaveCSS('opacity', '0')
  await expect(card).not.toContainText('Rabbit Hole')
  await expect(page.getByText('YOUR EXPLORATION')).toHaveCount(0)
  const heightBefore = await card.evaluate((el) => el.getBoundingClientRect().height)
  const position = await node.getAttribute('style')
  const viewport = await page.locator('.react-flow__viewport').getAttribute('style')
  await finishStream(page)
  await expect(card).toContainText('후속 문장입니다.')
  await expect(card).toHaveAttribute('aria-busy', 'false')
  await expect
    .poll(() => card.evaluate((el) => el.getBoundingClientRect().height))
    .toBeGreaterThan(heightBefore)
  await expect(node).toHaveAttribute('style', position!)
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style', viewport!)
  await page.getByRole('textbox', { name: '메시지 입력' }).fill('두 번째 단계도 구체화해줘')
  await page.getByRole('button', { name: '메시지 보내기' }).click()
  await expect(page.locator('.response-card')).toHaveCount(2)
  await expect(page.locator('.react-flow__edge-conversation')).toHaveCount(1)
  await expect(page.locator('.react-flow__edge-conversation .react-flow__edge-path')).toHaveAttribute(
    'marker-end',
    /url/,
  )
  expect((await calls(page))[1].continuation).toBe('completed-turn')
  await finishStream(page)
  await expect(page.locator('.response-card').last()).toHaveAttribute('aria-busy', 'false')
  await page.reload()
  await openHistory(page)
  await page.getByRole('button', { name: '실행 계획을 정리해줘', exact: true }).click()
  await expect(page.locator('.response-card')).toHaveCount(2)
  expect(await calls(page)).toHaveLength(0)
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style', viewport!)
})

test('cancel preserves partial text and ignores stale events after switching canvas', async ({ page }) => {
  await installStream(page)
  await page.route('**/api/jobs/*', (route) => route.fulfill({ status: 204 }))
  await page.goto('/')
  await page.getByRole('textbox', { name: '메시지 입력' }).fill('긴 설명')
  await page.getByRole('button', { name: '메시지 보내기' }).click()
  await expect(page.locator('.response-card')).toContainText('첫 번째 응답')
  await page.getByRole('button', { name: '응답 중지' }).click()
  await expect(page.locator('.response-card')).toContainText('중지됨')
  await openHistory(page)
  await page.getByRole('button', { name: '새 대화', exact: true }).click()
  await finishStream(page)
  await expect(page.locator('.response-card')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '호기심이 이어지는 곳' })).toBeVisible()
})

test('partial error keeps response text and retry uses the prior checkpoint', async ({ page }) => {
  let count = 0
  await page.route('**/api/agent', async (route) => {
    const request = route.request().postDataJSON()
    count++
    if (count === 2) {
      expect(request.continuation).toBe('before-turn')
      expect(request.query).toBe('설명해줘')
    }
    let seq = 0
    const id = 'response_' + request.request_id
    const ev = (type: string, data: object) =>
      `data: ${JSON.stringify({ version: 2, request_id: request.request_id, job_id: 'j', seq: ++seq, type, data })}\n\n`
    await route.fulfill({
      contentType: 'text/event-stream',
      body:
        ev('response_started', { id }) +
        ev('response_delta', { id, delta: '보존할 내용' }) +
        ev('part_error', { part: 'response', code: 'timeout', message: '응답 시간 초과' }) +
        ev('checkpoint', { continuation: 'before-turn' }) +
        ev('done', { status: 'partial', failed_parts: ['response'] }),
    })
  })
  await page.goto('/')
  await page.getByRole('textbox', { name: '메시지 입력' }).fill('설명해줘')
  await page.getByRole('button', { name: '메시지 보내기' }).click()
  await expect(page.locator('.response-card')).toContainText('보존할 내용')
  await expect(page.getByRole('alert')).toContainText('[timeout]')
  await page.getByRole('button', { name: '다시 요청', exact: true }).click()
  await expect(page.locator('.response-card')).toHaveCount(2)
})

test('composer and canvas tools stay separate while resizing with sidebar open or closed', async ({
  page,
}) => {
  await installStream(page)
  await page.goto('/')
  await expect(page.getByText('질문에서 아이디어로, 대화에서 다음 단계로.')).toHaveCount(0)
  await page.getByRole('textbox', { name: '메시지 입력' }).fill('레이아웃 확인')
  await page.getByRole('button', { name: '메시지 보내기' }).click()
  await expect(page.locator('.response-card')).toBeVisible()
  await finishStream(page)
  for (const width of [320, 390, 700, 768, 1024, 1101, 1200, 1280, 1366, 1440]) {
    await page.setViewportSize({ width, height: 844 })
    for (const open of [true, false]) {
      const toggle = page.getByRole('button', { name: open ? '대화 기록 펼치기' : '대화 기록 접기' })
      if (await toggle.isVisible()) await toggle.click()
      await expect
        .poll(() =>
          page.evaluate(() => {
            const input = document.querySelector('.composer')!.getBoundingClientRect()
            const tools = document.querySelector('.canvas-tools')!.getBoundingClientRect()
            return (
              input.left >= 0 &&
              input.right <= innerWidth &&
              tools.left >= 0 &&
              tools.right <= innerWidth &&
              (input.bottom + 8 <= tools.top ||
                input.right + 8 <= tools.left ||
                tools.right + 8 <= input.left)
            )
          }),
        )
        .toBe(true)
    }
  }
})

test('response actions copy Markdown, collapse content and branch from the chosen response', async ({
  page,
}) => {
  const requests: Record<string, unknown>[] = []
  const markdown = '# 답변\n\n' + '긴 응답을 스크롤로 확인합니다.\n\n'.repeat(30)
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          Object.assign(window, { copiedText: text })
        },
      },
    })
  })
  await page.route('**/api/title', (route) => route.fulfill({ status: 502, body: '{}' }))
  await page.route('**/api/agent', async (route) => {
    const request = route.request().postDataJSON()
    requests.push(request)
    const id = `response_${request.request_id}`
    const messages = [
      ['response_started', { id }],
      ['response_completed', { id, text: markdown }],
      ['checkpoint', { continuation: `context-${requests.length}` }],
      ['done', { status: 'completed', failed_parts: [] }],
    ]
    await route.fulfill({
      contentType: 'text/event-stream',
      body: messages
        .map(
          ([type, data], i) =>
            `data: ${JSON.stringify({ version: 2, request_id: request.request_id, job_id: 'j', seq: i + 1, type, data })}\n\n`,
        )
        .join(''),
    })
  })
  await page.goto('/')
  const input = page.getByRole('textbox', { name: '메시지 입력' })
  await input.fill('첫 질문')
  await page.getByRole('button', { name: '메시지 보내기' }).click()
  const first = page.locator('.response-card').first()
  await expect(first.locator('.response-status')).toHaveText('완료')
  await first.getByRole('button', { name: '복사하기', exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as { copiedText: string }).copiedText)).toBe(markdown)
  await expect(first.getByRole('button', { name: '복사 완료', exact: true })).toBeVisible()
  await expect(first.getByRole('button', { name: '복사하기', exact: true })).toBeVisible({ timeout: 4000 })
  const before = await first.evaluate((el) => el.getBoundingClientRect().height)
  await first.getByRole('button', { name: '응답 접기' }).click()
  await expect(first.getByRole('button', { name: '응답 확장' })).toBeVisible()
  await expect.poll(() => first.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(before)
  expect(await first.locator('.response-content').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(
    true,
  )
  await input.fill('두 번째 질문')
  await page.getByRole('button', { name: '메시지 보내기' }).click()
  await expect(page.locator('.response-card')).toHaveCount(2)
  await first.getByRole('button', { name: '이어서 질문하기', exact: true }).click()
  await expect(input).toBeFocused()
  await expect(page.locator('.composer .reply-context')).toContainText('첫 질문')
  await expect(first).toHaveClass(/is-reply-target/)
  await first.getByRole('button', { name: '이어서 질문하기', exact: true }).click()
  await expect(first).not.toHaveClass(/is-reply-target/)
  await expect(first.getByRole('button', { name: '이어서 질문하기', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await expect(page.locator('.reply-context')).toHaveCount(0)
  await first.getByRole('button', { name: '이어서 질문하기', exact: true }).click()
  await expect(page.getByText('이 응답에 이어서:', { exact: false })).toHaveCount(0)
  await page.getByRole('button', { name: '이어서 질문 취소', exact: true }).click()
  await expect(first).not.toHaveClass(/is-reply-target/)
  await expect(page.locator('.reply-context')).toHaveCount(0)
  await first.getByRole('button', { name: '이어서 질문하기', exact: true }).click()
  await input.fill('첫 응답에서 분기')
  await page.getByRole('button', { name: '메시지 보내기' }).click()
  await expect(page.locator('.response-card')).toHaveCount(3)
  expect(requests[2].continuation).toBe('context-1')
  const parent = `response_${requests[0].request_id}`
  const branch = `response_${requests[2].request_id}`
  await expect(page.locator(`[data-testid="rf__edge-conversation-${parent}-${branch}"]`)).toHaveCount(1)
  await page.reload()
  await openHistory(page)
  await page.getByRole('button', { name: '첫 질문', exact: true }).click()
  await expect(page.locator('.response-card')).toHaveCount(3)
  await expect(page.locator('.response-card').first()).toHaveClass(/is-collapsed/)
  expect(requests).toHaveLength(3)
  const navigation = page.getByRole('navigation', { name: '노드 탐색' })
  await expect(navigation).toContainText('1/3')
  await expect(navigation.getByRole('button', { name: '이전 노드' })).toBeDisabled()
  await navigation.getByRole('button', { name: '다음 노드' }).click()
  await expect(navigation).toContainText('2/3')
  await expect(page.locator('.response-card').nth(1)).toHaveClass(/is-selected/)
  await page.keyboard.press('d')
  await expect(navigation).toContainText('3/3')
  await expect(page.locator('.response-card').nth(2)).toHaveClass(/is-selected/)
  await expect(navigation.getByRole('button', { name: '다음 노드' })).toBeDisabled()
  await page.keyboard.press('a')
  await expect(navigation).toContainText('2/3')
})

test('wheel pans vertically, Control-wheel zooms and sidebar shortcut toggles outside the editor', async ({
  page,
}) => {
  await page.goto('/')
  const transform = () => page.locator('.react-flow__viewport').getAttribute('style')
  const zoom = () => page.locator('.canvas-tools span').innerText()
  const initialZoom = await zoom()
  const before = await transform()
  await page.mouse.move(300, 200)
  await page.mouse.wheel(0, 160)
  await expect.poll(transform).not.toBe(before)
  expect(await zoom()).toBe(initialZoom)
  const position = () =>
    page.locator('.react-flow__viewport').evaluate((el) => {
      const matrix = new DOMMatrix(getComputedStyle(el).transform)
      return { x: matrix.m41, y: matrix.m42 }
    })
  const vertical = await position()
  await page.keyboard.down('Shift')
  await page.mouse.wheel(0, 120)
  await page.keyboard.up('Shift')
  await expect.poll(async () => (await position()).x).not.toBe(vertical.x)
  expect((await position()).y).toBe(vertical.y)
  const horizontal = await position()
  await page.mouse.wheel(80, 60)
  await expect.poll(async () => (await position()).x).not.toBe(horizontal.x)
  await expect.poll(async () => (await position()).y).not.toBe(horizontal.y)
  expect(await zoom()).toBe(initialZoom)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -160)
  await page.keyboard.up('Control')
  await expect.poll(zoom).not.toBe(initialZoom)
  const beforeQ = await zoom()
  await page.keyboard.press('s')
  await expect.poll(zoom).not.toBe(beforeQ)
  // Let the animated zoom finish before reversing it.
  await page.waitForTimeout(200)
  const beforeE = await zoom()
  await page.keyboard.press('w')
  await expect.poll(zoom).not.toBe(beforeE)
  await page.waitForTimeout(200)
  await page.keyboard.down('s')
  await page.waitForTimeout(200)
  const heldZoom = await zoom()
  await page.keyboard.down('s') // Repeated keydown while the key remains held.
  await expect.poll(zoom).not.toBe(heldZoom)
  await page.keyboard.up('s')
  const releasedZoom = await zoom()
  await page.waitForTimeout(200)
  expect(await zoom()).toBe(releasedZoom)
  const brand = page.locator('.brand')
  const expanded = await brand.getAttribute('aria-expanded')
  const color = await brand.evaluate((el) => getComputedStyle(el).backgroundColor)
  await brand.hover()
  expect(await brand.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(color)
  await page.keyboard.press('Control+b')
  await expect(brand).toHaveAttribute('aria-expanded', expanded === 'true' ? 'false' : 'true')
  await page.keyboard.press('Control+b')
  await expect(brand).toHaveAttribute('aria-expanded', expanded!)
  await page.getByRole('textbox', { name: '메시지 입력' }).focus()
  const editorZoom = await zoom()
  await page.keyboard.type('wsad')
  expect(await zoom()).toBe(editorZoom)
  await expect(page.getByRole('textbox', { name: '메시지 입력' })).toHaveValue('wsad')
  await page.keyboard.press('Control+b')
  await expect(brand).toHaveAttribute('aria-expanded', expanded!)
})

test('selecting a response focuses it and wheel over selected content still pans the canvas', async ({
  page,
}) => {
  await installStream(page)
  await page.goto('/')
  await page.getByRole('textbox', { name: '메시지 입력' }).fill('노드 포커스')
  await page.getByRole('button', { name: '메시지 보내기' }).click()
  await finishStream(page)
  const card = page.locator('.response-card').first()
  await expect(card).toHaveAttribute('aria-busy', 'false')
  const transform = () => page.locator('.react-flow__viewport').getAttribute('style')
  await expect.poll(() => page.locator('.canvas-tools span').innerText()).not.toBe('100%')
  const zoom = await page.locator('.canvas-tools span').innerText()
  await card.locator('h2').click()
  await expect(card).toHaveClass(/is-selected/)
  // Wait for the focus animation before testing a new independent wheel gesture.
  await page.waitForTimeout(300)
  const focused = await transform()
  await card.locator('.response-content').hover()
  await page.mouse.wheel(0, 100)
  await expect.poll(transform).not.toBe(focused)
  expect(await page.locator('.canvas-tools span').innerText()).toBe(zoom)
  const panned = await transform()
  await card.locator('h2').click()
  await expect.poll(transform).not.toBe(panned)
})
