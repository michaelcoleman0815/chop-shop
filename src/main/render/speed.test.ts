import { describe, expect, it } from 'vitest'
import { srcLength, stepsForSource } from '../../shared/edit'
import { soundChunks, speedSound } from './speed'

const outOf = (steps: { srcSec: number; speed: number }[]): number =>
  steps.reduce((sum, s) => sum + s.srcSec / s.speed, 0)

describe('the sound of a speed ramp', () => {
  const ramp = stepsForSource(3, 0.5, { inSec: 0.3, outSec: 0.3 })

  it('plays a ramp in three stretches: the ease in, the steady middle and the ease out', () => {
    expect(ramp.length).toBeGreaterThan(10)
    const chunks = soundChunks(ramp)
    expect(chunks).toHaveLength(3)
    // Every stretch takes exactly as long as the steps it plays, so each starts where the picture's does.
    expect(srcLength(chunks)).toBeCloseTo(srcLength(ramp), 9)
    expect(outOf(chunks)).toBeCloseTo(outOf(ramp), 9)
    expect(chunks[1].speed).toBeCloseTo(0.5, 9)
    expect(chunks[0].speed).toBeGreaterThan(0.5)
    expect(chunks[0].speed).toBeLessThan(1)
  })

  it('leaves a single speed whole', () => {
    expect(soundChunks([{ srcSec: 2, speed: 1.5 }])).toEqual([{ srcSec: 2, speed: 1.5 }])
  })

  it("plays each stretch with its own atempo instead of atempo's tempo command, which ffmpeg 6.0 ignores", () => {
    const graph = speedSound(ramp, 'a3c', 'a3t', 'a3')
    expect(graph).not.toContain('asendcmd')
    expect(graph).toContain('asplit=3[a3k0i][a3k1i][a3k2i]')
    expect(graph).toContain('[a3k0][a3k1][a3k2]concat=n=3:v=0:a=1,asetpts=N/SR/TB[a3t]')
    // Each cut to exactly its length, after its own lead is taken back.
    for (const c of soundChunks(ramp)) expect(graph).toContain(`atrim=duration=${(c.srcSec / c.speed).toFixed(6)}`)
  })
})
