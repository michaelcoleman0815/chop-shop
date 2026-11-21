import { describe, expect, it } from 'vitest'
import { inTime, NEW_CHAT_WAIT_MS } from './in-time'

/** Work waited on only so long (a new video's chat being made): its answer, 'late' after its time, or its failure. */

describe('inTime', () => {
  it('answers with the work when it comes in time', async () => {
    expect(await inTime(Promise.resolve('made'), 50)).toBe('made')
  })

  it('answers late once its time has passed, and the work goes on', async () => {
    let finished = false
    const work = new Promise<string>((r) =>
      setTimeout(() => {
        finished = true
        r('made after all')
      }, 80)
    )
    expect(await inTime(work, 20)).toBe('late')
    expect(finished).toBe(false)
    expect(await work).toBe('made after all')
  })

  it('passes a failure on, and waits 15 seconds for a new chat', async () => {
    await expect(inTime(Promise.reject(new Error('disk full')), 50)).rejects.toThrow('disk full')
    expect(NEW_CHAT_WAIT_MS).toBe(15_000)
  })
})
