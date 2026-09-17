import { test, expect, type Page } from '@playwright/test'
test.beforeEach(async ({ page }) => {
  // No unmocked structure call may reach a local backend during browser tests.
  await page.route('**/api/structure', (route) => route.fulfill({ status: 502, body: '{}' }))
})
async function openHistory(page: Page) {
  const expand = page.getByRole('button', { name: '대화 기록 펼치기' })
  if (await expand.isVisible()) await expand.click()
}
test('welcome shows the brand without example question cards', async ({ page }, testInfo) => {
  let calls = 0
  await page.route('**/api/agent', async (route) => {
    calls++
    await route.abort()
  })
  await page.goto('/')
  await expect(page.locator('.welcome-brand')).toHaveText('Rabbit Hole')
  await expect(page.locator('.welcome-brand svg')).toBeVisible()
  await expect(page.getByRole('heading', { name: '호기심이 이어지는 곳' })).toBeVisible()
  await expect(page.locator('.suggestions')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('welcome.png') })
  await expect(page.getByRole('textbox', { name: '메시지 입력' })).toHaveValue('')
  await openHistory(page)
  await expect(page.getByRole('button', { name: '디자인 예시 둘러보기' })).toHaveCount(0)
  await expect(page.locator('.sample-menu, .sample-controls')).toHaveCount(0)
  expect(calls).toBe(0)
})

test('history count follows its heading and long icon-free history scrolls inside the sidebar', async ({
  page,
}, testInfo) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('rabbit-hole', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('sessions', 'readwrite')
      for (let i = 0; i < 60; i++)
        tx.objectStore('sessions').put({
          id: `history-${i}`,
          query: `저장된 대화 ${i + 1}`,
          updatedAt: 1000 - i,
          mode: 'live',
          protocol: 2,
          nodes: [],
          sources: [],
          graph: { relations: [], clusters: [] },
          answer: null,
          viewport: { x: 0, y: 0, zoom: 1 },
          fitted: false,
          pinned: [],
          status: 'completed',
          failedParts: [],
        })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  })
  await page.reload()
  await openHistory(page)
  await expect(page.locator('.history-panel h2')).toHaveText('최근 대화 60')
  await expect(page.locator('.history-item svg')).toHaveCount(0)
  if (testInfo.project.name === 'desktop') {
    const row = page.locator('.history-row').first()
    const remove = row.locator('.history-delete')
    await row.locator('.history-item').click()
    await expect(remove).toHaveCSS('opacity', '1')
    await page.mouse.move(800, 100)
    await expect(remove).toHaveCSS('opacity', '0')
    await page.keyboard.press('Tab')
    await expect(remove).toBeFocused()
    await expect(remove).toHaveCSS('opacity', '1')
    await page.getByRole('textbox', { name: '메시지 입력' }).focus()
  }
  const geometry = await page.locator('.history-panel h2').evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el.firstChild!)
    return el.querySelector('span')!.getBoundingClientRect().left - range.getBoundingClientRect().right
  })
  expect(geometry).toBeLessThan(15)
  const scrolled = await page.locator('.history-list').evaluate((el) => {
    el.scrollTop = el.scrollHeight
    return { y: el.scrollTop, overflow: getComputedStyle(el).overflowY }
  })
  expect(scrolled.y).toBeGreaterThan(0)
  expect(scrolled.overflow).toBe('auto')
  await expect(page.getByRole('button', { name: '저장된 대화 60', exact: true })).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('history-scroll.png') })
})

test('completed response becomes three node types and retries do not duplicate or move existing nodes', async ({
  page,
}, testInfo) => {
  const excerpt =
    '벡터 검색은 의미를 비교합니다. 도메인에 따라 정확도가 달라집니다. [원문](https://example.com/a)'
  const answer = `첫 번째 응답입니다.\n\n${excerpt}\n\n${'나머지 답변을 원래 응답에 그대로 보존합니다. '.repeat(8)}`
  let structureCalls = 0
  let finishStructure!: () => void
  const structureReady = new Promise<void>((resolve) => { finishStructure = resolve })
  await page.route('**/api/title', (route) => route.fulfill({ status: 502, body: '{}' }))
  await page.route('**/api/structure', async (route) => {
    structureCalls++
    if (structureCalls === 1) {
      await route.fulfill({ status: 502, body: '{}' })
      return
    }
    await structureReady
    const request = route.request().postDataJSON()
    const start = Array.from(answer.slice(0, answer.indexOf(excerpt))).length
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        version: 1,
        text_hash: request.text_hash,
        items: [
          {
            key: 'd'.repeat(24),
            subtype: 'concept',
            title: { start, end: start + 5, quote: '벡터 검색' },
            excerpt: { start, end: start + Array.from(excerpt).length, quote: excerpt },
          },
        ],
      }),
    })
  })
  await page.route('**/api/agent', async (route) => {
    const request = route.request().postDataJSON(),
      id = `response_${request.request_id}`
    const events = [
      ['response_started', { id }],
      ['response_completed', { id, text: answer }],
      [
        'response_sources',
        {
          id,
          sources: [
            {
              id: `src_${'a'.repeat(24)}`,
              url: 'https://example.com/a',
              title: '실제 조회 기록',
              access: 'page_read',
              verification: 'unverified',
              accessed_at: '2026-09-17T00:00:00Z',
            },
          ],
        },
      ],
      ['checkpoint', { continuation: 'signed' }],
      ['done', { status: 'completed', failed_parts: [] }],
    ]
    await route.fulfill({
      contentType: 'text/event-stream',
      body: events
        .map(
          ([type, data], index) =>
            `data: ${JSON.stringify({ version: 2, request_id: request.request_id, job_id: 'j', seq: index + 1, type, data })}\n\n`,
        )
        .join(''),
    })
  })
  await page.goto('/')
  await page.getByRole('textbox', { name: '메시지 입력' }).fill('정보와 출처를 정리해줘')
  await page.getByRole('button', { name: '메시지 보내기' }).click()
  const retry = page.getByRole('button', { name: '구조화 재시도' })
  await expect(retry).toBeVisible()
  await expect(page.locator('.source-card')).toHaveCount(1)
  await expect(page.locator('.information-card')).toHaveCount(0)
  await page.locator('.response-card').getByRole('button', { name: '응답 접기' }).click()
  const before = await page.locator('.react-flow__node-response').getAttribute('style')
  await retry.click()
  const progress = page.locator('.response-card > header .response-status')
  await expect(progress).toHaveText('정보 정리 중')
  await expect(progress.locator('.rabbit-loader')).toBeVisible()
  await expect(progress).toHaveCSS('color', 'rgb(114, 144, 123)')
  await expect(page.locator('.response-card footer')).toHaveCount(0)
  finishStructure()
  await expect(progress).toHaveText('완료')
  await expect(page.locator('.information-card')).toHaveCount(1)
  await expect(page.locator('.information-card')).toHaveCSS('animation-name', 'content-arrive')
  await expect(page.locator('.react-flow__edge-content .connection-reveal').first()).toHaveCSS('animation-name', 'edge-arrive')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('.information-card')).toHaveCSS('animation-name', 'none')
  await expect(page.locator('.connection-reveal').first()).toHaveCSS('animation-name', 'none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(page.locator('.react-flow__node-response')).toHaveAttribute('style', before!)
  await expect(page.locator('.response-card')).toHaveCount(1)
  await expect(page.locator('.content-edge-label').filter({ hasText: '정보 추출' })).toHaveCount(1)
  await page.getByRole('button', { name: '화면 맞춤', exact: true }).click()
  await expect.poll(() => page.locator('.source-card').evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    return bounds.left >= 0 && bounds.right <= window.innerWidth
  })).toBe(true)
  expect(await page.evaluate(() => window.scrollX)).toBe(0)
  await page.locator('.source-card').getByRole('button', { name: '복사하기', exact: true }).focus()
  await expect(page.getByRole('tooltip')).toHaveText('복사하기')
  expect(await page.getByRole('tooltip').evaluate((el) => {
    const rect = el.getBoundingClientRect()
    return el.parentElement === document.body && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
  })).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.locator('.source-card').getByRole('button', { name: '노드 접기' })).toBeDisabled()
  await expect(page.locator('.information-card').getByRole('button', { name: '노드 접기' })).toBeDisabled()
  await expect(page.locator('.source-card').getByRole('link', { name: '페이지 열기' })).toBeVisible()
  await page.locator('.information-card').getByRole('button', { name: '다음 응답에 사용' }).click()
  await expect(page.locator('.reply-context')).toContainText('벡터 검색')
  await expect(page.locator('.information-card')).toHaveClass(/is-reply-target/)
  await expect(page.locator('.information-card')).toHaveCSS('animation-name', 'content-reply-highlight')
  await expect(page.locator('.information-card header .response-status')).toHaveCSS('font-weight', '650')
  await expect(page.locator('.information-card header .response-status')).toHaveCSS('color', 'rgb(150, 116, 35)')
  await page.getByRole('button', { name: '이어서 질문 취소' }).click()
  await expect(page.locator('.information-card')).not.toHaveClass(/is-reply-target/)
  await expect(page.locator('.information-card')).toHaveCSS('animation-name', 'none')
  await page.locator('.source-card').getByRole('button', { name: '다음 응답에 사용' }).click()
  await expect(page.locator('.source-card')).toHaveCSS('animation-name', 'content-reply-highlight')
  await expect(page.locator('.source-card header .response-status')).toHaveCSS('color', 'rgb(63, 115, 171)')
  await page.locator('.source-card').getByRole('button', { name: '다음 응답에 사용' }).click()
  await expect(page.locator('.source-card')).toHaveCSS('animation-name', 'none')
  await page.screenshot({ path: testInfo.outputPath('three-node-graph.png') })
  await expect(page.getByText('미검증', { exact: false })).toHaveCount(0)
  await expect(page.locator('.response-card').getByRole('button', { name: '이전 노드로' })).toBeDisabled()
  await page.locator('.source-card').getByRole('button', { name: '이전 노드로' }).click()
  await expect.poll(() => page.locator('.source-card .previous-node').evaluate((root) => {
    const button = root.querySelector('button')!.getBoundingClientRect()
    const menu = root.querySelector('.previous-node-options')!.getBoundingClientRect()
    return menu.top >= button.bottom
  })).toBe(true)
  await page.locator('.source-card').getByRole('button', { name: '정보 · 벡터 검색', exact: true }).click()
  await expect(page.locator('.information-card')).toHaveClass(/is-selected/)
  await page.locator('.information-card').getByRole('button', { name: '이전 노드로' }).click()
  await expect(page.locator('.response-card')).toHaveClass(/is-selected/)
  await expect(page.locator('.origin-excerpt')).toHaveCount(0)
  await page.reload()
  await openHistory(page)
  await page.getByRole('button', { name: '정보와 출처를 정리해줘', exact: true }).click()
  await expect(page.locator('.information-card')).toHaveCount(1)
  await expect(page.locator('.source-card')).toHaveCount(1)
  await expect(page.locator('.information-card')).toHaveCSS('animation-name', 'none')
  await expect(page.locator('.connection-reveal')).toHaveCount(0)
  expect(structureCalls).toBe(2)
  const originalId = await page.locator('.react-flow__node-response').getAttribute('data-id')
  const informationId = await page.locator('.react-flow__node-information').getAttribute('data-id')
  await page.getByRole('button', { name: '화면 맞춤', exact: true }).click()
  await page.locator('.information-card').getByRole('button', { name: '다음 응답에 사용' }).click()
  await page.getByRole('textbox', { name: '메시지 입력' }).fill('이 정보에서 이어서 설명해줘')
  await page.getByRole('button', { name: '메시지 보내기' }).click()
  await expect(page.locator('.react-flow__node-response')).toHaveCount(2)
  const nextId = await page.locator('.react-flow__node-response').last().getAttribute('data-id')
  await expect(page.locator(`.react-flow__edge[data-id="conversation-${informationId}-${nextId}"]`)).toHaveCount(1)
  await expect(page.locator(`.react-flow__edge[data-id="conversation-${originalId}-${nextId}"]`)).toHaveCount(0)
  await expect(page.locator(`.react-flow__edge[data-id="uses_context:${nextId}:${informationId}"]`)).toHaveCount(0)
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

test('tool retrieval history distinguishes access and restores without new requests', async ({
  page,
}, testInfo) => {
  let requests = 0
  await page.route('**/api/title', (route) => route.fulfill({ status: 502, body: '{}' }))
  await page.route('**/api/agent', async (route) => {
    requests++
    const request = route.request().postDataJSON()
    const id = `response_${request.request_id}`
    const sources = [
      {
        id: `src_${'a'.repeat(24)}`,
        url: 'https://example.com/a',
        title: '검색으로 찾은 페이지',
        access: 'search_result',
        accessed_at: '2026-09-17T00:00:00+00:00',
        verification: 'unverified',
        content: { status: 'failed', text: '', truncated: false, final_url: null, error_code: 'page_unavailable' },
      },
      {
        id: `src_${'b'.repeat(24)}`,
        url: 'https://example.com/b',
        title: '본문을 읽은 페이지',
        access: 'page_read',
        accessed_at: '2026-09-17T00:00:01+00:00',
        verification: 'unverified',
        content: {
          status: 'read',
          text: '<script>이 내용은 실행되지 않는 원문입니다.</script>\n' + '페이지에서 확보한 실제 본문 내용입니다.\n'.repeat(30),
          truncated: true,
          final_url: 'https://example.com/b',
          error_code: null,
        },
      },
    ]
    const events = [
      ['started', { access_token: 'test-token' }],
      ['response_started', { id }],
      ['response_completed', { id, text: '계산 결과는 0.3입니다. [참고 페이지](https://example.com/b)' }],
      ['response_sources', { id, sources }],
      ['checkpoint', { continuation: 'completed-turn' }],
      ['done', { status: 'completed', failed_parts: [] }],
    ]
    await route.fulfill({
      contentType: 'text/event-stream',
      body: events
        .map(
          ([type, data], index) =>
            `data: ${JSON.stringify({ version: 2, request_id: request.request_id, job_id: 'j', seq: index + 1, type, data })}\n\n`,
        )
        .join(''),
    })
  })
  await page.goto('/')
  await page.getByRole('textbox', { name: '메시지 입력' }).fill('계산과 자료 확인')
  await page.getByRole('button', { name: '메시지 보내기' }).click()
  await expect(page.locator('.source-card')).toHaveCount(2)
  const sourceCard = page.locator('.source-card').filter({ hasText: '본문을 읽은 페이지' })
  await expect(sourceCard.locator('.source-body')).toContainText('<script>이 내용은 실행되지 않는 원문입니다.</script>')
  await expect(sourceCard.locator('script')).toHaveCount(0)
  await expect(sourceCard).toContainText('본문 일부 · 길이 제한으로 잘림')
  await expect(page.locator('.source-card').filter({ hasText: '검색으로 찾은 페이지' })).toContainText('이 페이지의 본문을 가져오지 못했습니다.')
  await page.getByRole('button', { name: '화면 맞춤', exact: true }).click()
  await expect(sourceCard.getByRole('button', { name: '노드 펼치기' })).toBeEnabled()
  await sourceCard.getByRole('button', { name: '노드 펼치기' }).click()
  await expect(sourceCard).not.toHaveClass(/is-collapsed/)
  await sourceCard.getByRole('button', { name: '노드 접기' }).click()
  await expect(sourceCard).toHaveClass(/is-collapsed/)
  await expect(page.locator('.response-sources')).toHaveCount(0)
  await expect(page.locator('.source-card').filter({ hasText: '검색으로 찾은 페이지' })).toContainText(
    '페이지 요약',
  )
  await expect(page.locator('.source-card').filter({ hasText: '본문을 읽은 페이지' })).toContainText(
    '페이지 요약',
  )
  await expect(page.locator('.content-edge-label').filter({ hasText: '출처 표기' })).toHaveCount(1)
  await expect(page.locator('.content-edge-label').filter({ hasText: /^조회$/ })).toHaveCount(1)
  await expect(page.locator('.response-card')).toHaveCount(1)
  await expect(page.locator('.page-card')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('tool-sources.png') })
  await page.reload()
  await openHistory(page)
  await page.getByRole('button', { name: '계산과 자료 확인', exact: true }).click()
  await expect(page.locator('.source-card')).toHaveCount(2)
  await expect(sourceCard.locator('.source-body')).toContainText('페이지에서 확보한 실제 본문 내용입니다.')
  await expect(sourceCard).toHaveClass(/is-collapsed/)
  expect(requests).toBe(1)
})

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
  await expect(card.locator('.response-status .rabbit-loader')).toBeVisible()
  await expect(card.locator('.rabbit-loader')).toHaveCount(1)
  await expect(card.locator('.rabbit-loader > g')).toHaveCSS('fill', 'rgb(114, 144, 123)')
  await expect(page.locator('.agent-status .rabbit-loader > g')).toHaveCSS('fill', 'rgb(114, 144, 123)')
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
  await page.getByRole('button', { name: 'Rabbit Hole', exact: true }).click()
  await expect(page.getByRole('heading', { name: '호기심이 이어지는 곳' })).toBeVisible()
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
      if (width > 700) {
        await expect.poll(() => page.evaluate(() => {
          const brand = document.querySelector('.sidebar-header .brand')!.getBoundingClientRect()
          const heading = document.querySelector('.canvas-heading')!.getBoundingClientRect()
          const navigation = document.querySelector('.node-navigation')!.getBoundingClientRect()
          const center = (rect: DOMRect) => rect.top + rect.height / 2
          return Math.abs(center(brand) - center(heading)) < 1 &&
            Math.abs(center(brand) - center(navigation)) < 1 &&
            heading.right + 12 <= navigation.left && brand.right <= heading.left
        })).toBe(true)
      }
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
  await expect(first.locator('.response-status')).toHaveText('정보 정리 실패')
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
  await expect(first).toHaveCSS('animation-name', 'none')
  await expect(first.getByRole('button', { name: '이어서 질문하기', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await expect(page.locator('.reply-context')).toHaveCount(0)
  await first.getByRole('button', { name: '이어서 질문하기', exact: true }).click()
  await expect(page.getByText('이 응답에 이어서:', { exact: false })).toHaveCount(0)
  await page.getByRole('button', { name: '이어서 질문 취소', exact: true }).click()
  await expect(first).not.toHaveClass(/is-reply-target/)
  await expect(first).toHaveCSS('animation-name', 'none')
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

test('long information collapses like a response while short sources cannot collapse', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const text = '자세한 정보와 조건을 보존하는 문장입니다.\n\n'.repeat(20)
    const entities: Record<string, unknown> = {
      info_long: { id: 'info_long', type: 'information', subtype: 'concept', responseId: 'r', textHash: 'a'.repeat(64),
        title: { start: 0, end: 5, quote: '자세한 정보' }, excerpt: { start: 0, end: text.length, quote: text } },
    }
    const nodes: unknown[] = [
      { id: 'r', type: 'response', position: { x: 0, y: 0 }, width: 560,
        data: { prompt: '접기와 출처 표시', text: '짧은 답변', status: 'completed', continuation: 'signed' } },
      { id: 'info_long', type: 'information', position: { x: 650, y: 0 }, width: 340, height: 130, data: { entityId: 'info_long' } },
    ]
    for (let i = 0; i < 8; i++) {
      const id = `source_${i}`
      entities[id] = { id, type: 'source', observations: [], source: { id, url: `https://example.com/${i}`,
        title: `출처 ${i}`, access: 'search_result', accessed_at: '2026-09-17', verification: 'unverified' } }
      nodes.push({ id, type: 'source', position: { x: 1100, y: i * 280 }, width: 460, height: 260, data: { entityId: id } })
    }
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('rabbit-hole', 1)
      request.onsuccess = () => resolve(request.result)
    })
    await new Promise<void>((resolve) => {
      const tx = db.transaction('sessions', 'readwrite')
      tx.objectStore('sessions').put({ id: 'collapse-test', query: '접기와 출처 표시', updatedAt: Date.now(),
        mode: 'live', protocol: 2, nodes, sources: [], graph: { relations: [], clusters: [] }, answer: null,
        pinned: [], status: 'completed', failedParts: [], fitted: true, viewport: { x: 0, y: 150, zoom: .7 },
        contentGraph: { version: 1, entities, relations: [{ id: 'extract', source: 'r', target: 'info_long', kind: 'has_extract', responseId: 'r', spans: [] }], jobs: {} } })
      tx.oncomplete = () => resolve()
    })
    db.close()
  })
  await page.reload()
  await openHistory(page)
  await page.getByRole('button', { name: '접기와 출처 표시', exact: true }).click()
  await expect(page.locator('.source-card')).toHaveCount(8)
  if (await page.getByRole('button', { name: '대화 기록 접기' }).isVisible()) await page.getByRole('button', { name: '대화 기록 접기' }).click()
  await page.getByRole('button', { name: '화면 맞춤', exact: true }).click()
  const info = page.locator('.information-card')
  await expect(info.getByRole('button', { name: '노드 접기' })).toBeEnabled()
  await info.getByRole('button', { name: '노드 접기' }).click()
  await expect(info).toHaveClass(/is-collapsed/)
  await expect(info.locator('h2').first()).toHaveText('자세한 정보')
  await expect(info.getByRole('button', { name: '이전 노드로' })).toBeVisible()
  expect(await info.locator('.information-body').evaluate((el) => el.clientHeight <= 161 && el.scrollHeight > el.clientHeight)).toBe(true)
  await info.getByRole('button', { name: '노드 펼치기' }).click()
  expect(await info.locator('.information-body').evaluate((el) => el.clientHeight > 160)).toBe(true)
  await expect(page.locator('.source-card').first().getByRole('button', { name: '노드 접기' })).toBeDisabled()
  await page.reload()
  await openHistory(page)
  await page.getByRole('button', { name: '접기와 출처 표시', exact: true }).click()
  await expect(page.locator('.source-card')).toHaveCount(8)
})

test('source cards show lookup and summary spinners then persist the page summary', async ({ page }) => {
  await page.route('**/api/title', (route) => route.fulfill({ status: 502, body: '{}' }))
  await page.route('**/api/structure', (route) => route.fulfill({ status: 502, body: '{}' }))
  await page.addInitScript(() => {
    const original = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      if (input !== '/api/agent') return original(input, init)
      const request = JSON.parse(init!.body as string)
      const id = `response_${request.request_id}`
      let seq = 0
      let phase = 0
      const source = {
        id: 'src_' + 'a'.repeat(24), title: '페이지 제목', url: 'https://example.com/article',
        access: 'search_result', accessed_at: '2026-09-17T00:00:00Z', verification: 'unverified',
        content: { status: 'reading', text: '', truncated: false, final_url: null as string | null, error_code: null, summary: '', summary_error: null },
      }
      return new Response(new ReadableStream({
        start(controller) {
          const emit = (type: string, data: object) => controller.enqueue(new TextEncoder().encode(
            `data: ${JSON.stringify({ version: 2, request_id: request.request_id, job_id: 'j', seq: ++seq, type, data })}\n\n`,
          ))
          emit('started', { access_token: 'token' })
          emit('response_started', { id })
          emit('response_completed', { id, text: '원래 답변입니다.' })
          emit('status', { stage: 'reading_sources' })
          emit('response_sources', { id, sources: [source] })
          Object.assign(window, { nextSourcePhase: () => {
            phase++
            source.access = 'page_read'
            source.content.text = 'Only the actual page body. '.repeat(50)
            source.content.final_url = source.url
            source.content.status = phase < 3 ? 'summarizing' : 'read'
            if (phase === 2) source.content.summary = '• 이 페이지는 병렬 처리 방법을'
            if (phase === 3) source.content.summary = '• 이 페이지는 병렬 처리 방법을 설명합니다.\n• 실제 본문에 있는 핵심 내용을 요약했습니다.'
            emit('response_sources', { id, sources: [source] })
            if (phase === 3) {
              emit('checkpoint', { continuation: 'signed' })
              emit('done', { status: 'completed', failed_parts: [] })
              controller.close()
            }
          } })
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } })
    }
  })
  await page.goto('/')
  await page.getByRole('textbox', { name: '메시지 입력' }).fill('페이지 요약 테스트')
  await page.getByRole('button', { name: '메시지 보내기' }).click()
  const card = page.locator('.source-card')
  await expect(card.locator('.source-access')).toHaveText('페이지 요약')
  await expect(card.getByRole('status')).toHaveText('조회 중')
  await expect(card.locator('.rabbit-loader')).toHaveCount(1)
  await expect(card).toHaveAttribute('aria-busy', 'true')
  const position = await page.locator('.react-flow__node-source').evaluate((el) => (el as HTMLElement).style.transform)
  await page.evaluate(() => (window as unknown as { nextSourcePhase: () => void }).nextSourcePhase())
  await expect(card.getByRole('status')).toHaveText('요약 중')
  await expect(card.locator('.rabbit-loader')).toHaveCount(1)
  await page.evaluate(() => (window as unknown as { nextSourcePhase: () => void }).nextSourcePhase())
  await expect(card.getByRole('status')).toHaveText('요약 중')
  await expect(card.locator('.source-body')).toHaveText('• 이 페이지는 병렬 처리 방법을')
  await expect(card.locator('.rabbit-loader')).toHaveCount(1)
  await expect(card.locator('.rabbit-loader-paw')).toHaveCSS('animation-name', 'rabbit-dig')
  await page.evaluate(() => (window as unknown as { nextSourcePhase: () => void }).nextSourcePhase())
  await expect(card.getByRole('status')).toHaveText('요약 완료')
  await expect(card.locator('.rabbit-loader')).toHaveCount(0)
  await expect(card.locator('.source-body')).toContainText('이 페이지는 병렬 처리 방법')
  await expect(card).not.toContainText('Only the actual page body')
  expect(await page.locator('.react-flow__node-source').evaluate((el) => (el as HTMLElement).style.transform)).toBe(position)
  await page.reload()
  await openHistory(page)
  await page.getByRole('button', { name: '페이지 요약 테스트', exact: true }).click()
  await expect(card.locator('.source-body')).toContainText('이 페이지는 병렬 처리 방법')
  await expect(card.locator('.rabbit-loader')).toHaveCount(0)
})

test('image search cards show preview title and original page and restore without search', async ({ page }) => {
  let requests = 0
  await page.route('https://upload.wikimedia.org/**', (route) => route.fulfill({
    contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'),
  }))
  await page.route('**/api/title', (route) => route.fulfill({ status: 502, body: '{}' }))
  await page.route('**/api/structure', (route) => route.fulfill({ status: 502, body: '{}' }))
  await page.route('**/api/agent', async (route) => {
    requests++
    const request = route.request().postDataJSON()
    const id = 'response_' + request.request_id
    const events = [
      ['response_started', { id }],
      ['response_completed', { id, text: '이미지를 찾았습니다.' }],
      ['response_sources', { id, sources: [{
        id: 'src_' + 'a'.repeat(24), title: 'Rabbit.jpg',
        url: 'https://commons.wikimedia.org/wiki/File:Rabbit.jpg',
        access: 'search_result', accessed_at: '2026-09-17T00:00:00Z', verification: 'unverified',
        image: { thumbnail_url: 'https://upload.wikimedia.org/wikipedia/commons/rabbit.png' },
      }] }],
      ['checkpoint', { continuation: 'signed' }],
      ['done', { status: 'completed', failed_parts: [] }],
    ]
    await route.fulfill({ contentType: 'text/event-stream', body: events.map(([type, data], i) =>
      'data: ' + JSON.stringify({ version: 2, request_id: request.request_id, job_id: 'j', seq: i + 1, type, data }) + '\n\n',
    ).join('') })
  })
  await page.goto('/')
  await page.getByRole('textbox', { name: '메시지 입력' }).fill('토끼 이미지')
  await page.getByRole('button', { name: '메시지 보내기' }).click()
  const card = page.locator('.source-card')
  await expect(card.getByRole('heading', { name: 'Rabbit.jpg' })).toBeVisible()
  await expect(card.locator('.node-tag')).toHaveText('이미지')
  await expect(card).toHaveCSS('background-color', 'rgb(247, 242, 252)')
  await expect(card.locator('.image-preview')).toHaveAttribute('referrerpolicy', 'no-referrer')
  await expect(card.getByRole('link', { name: '원본 페이지', exact: true })).toHaveAttribute('href', 'https://commons.wikimedia.org/wiki/File:Rabbit.jpg')
  await expect(card).not.toContainText('페이지 요약')
  await page.reload()
  await openHistory(page)
  await page.getByRole('button', { name: '토끼 이미지', exact: true }).click()
  await expect(card.locator('.image-preview')).toHaveCount(1)
  expect(requests).toBe(1)
  await card.locator('.image-preview').dispatchEvent('error')
  await expect(card).toContainText('이미지를 불러오지 못했습니다.')
  await expect(card.getByRole('link', { name: '원본 페이지', exact: true })).toHaveCount(1)
})
