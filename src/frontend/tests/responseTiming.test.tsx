import { act, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ResponseTimer } from '../src/components/ResponseTimer'
import { elapsedResponseTime, finishResponseStructure, finishResponseTiming, startResponseTiming } from '../src/lib/responseTiming'
import { makeSample } from './fixtures/legacySamples'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

it('measures monotonically through child generation and freezes each request independently', () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
  const first = { ...startResponseTiming('first'), responseId: 'response-first' }
  clock.mockReturnValue(2000)
  const second = { ...startResponseTiming('second'), responseId: 'response-second' }
  const session = { ...makeSample('vector'), responseTimings: { first, second } }
  clock.mockReturnValue(5500)
  vi.spyOn(Date, 'now').mockReturnValue(1) // A wall-clock change must not affect duration.
  const done = finishResponseStructure(session, 'response-first', 'completed')
  expect(done.responseTimings?.first).toMatchObject({ status: 'completed', durationMs: 4500 })
  expect(done.responseTimings?.second.status).toBe('running')
  clock.mockReturnValue(9000)
  expect(elapsedResponseTime('first', done.responseTimings!.first)).toBe(4500)
  const stopped = finishResponseTiming(done, 'second', 'cancelled')
  expect(stopped.responseTimings?.second).toMatchObject({ status: 'cancelled', durationMs: 7000 })
})

it('does not invent elapsed time for interrupted saved records or old records', () => {
  const session = { ...makeSample('vector'), responseTimings: { saved: { startedAt: 1000, status: 'running' as const } } }
  const restored = finishResponseTiming(session, 'saved', 'interrupted')
  expect(restored.responseTimings?.saved).toEqual({ startedAt: 1000, status: 'interrupted', durationMs: undefined })
  const view = render(<ResponseTimer timings={undefined} />)
  expect(screen.queryByLabelText('응답 및 노드 생성 시간')).toBeNull()
  view.rerender(<ResponseTimer timings={restored.responseTimings} />)
  expect(screen.getByLabelText('응답 및 노드 생성 시간')).toHaveTextContent('시간 기록 중단')
})

it('ticks only while running and retains the final duration after time passes', () => {
  vi.useFakeTimers()
  const timing = startResponseTiming('live')
  const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 1200)
  const view = render(<ResponseTimer timings={{ live: timing }} />)
  expect(screen.getByLabelText('응답 및 노드 생성 시간')).toHaveTextContent('생성 중 1.2초')
  clock.mockReturnValue(performance.now() + 1000)
  act(() => vi.advanceTimersByTime(100))
  expect(screen.getByLabelText('응답 및 노드 생성 시간')).toHaveTextContent('생성 중 2.2초')
  view.rerender(<ResponseTimer timings={{ live: { ...timing, status: 'completed', durationMs: 2500 } }} />)
  act(() => vi.advanceTimersByTime(5000))
  expect(screen.getByLabelText('응답 및 노드 생성 시간')).toHaveTextContent('응답 시간 2.5초')
})
