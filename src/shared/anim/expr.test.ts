import { readFileSync } from 'fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { color, num } from '../motion/anim'
import { checkExprs, noise1, parseExpr, runExpr, type ExprEnv } from './expr'

/**
 * The expression language: what it reads and refuses, what it gives, and
 * that it runs on its own interpreter, never reaching eval, Function or
 * anything global.
 */

const env = (over: Partial<ExprEnv> = {}): ExprEnv => ({ time: 0, value: 0, index: 0, duration: 4, ...over })

function value(src: string, over: Partial<ExprEnv> = {}): number | number[] {
  const p = parseExpr(src)
  if (!p.ok) throw new Error(p.reason)
  const r = runExpr(p.expr, env(over))
  if (!r.ok) throw new Error(r.reason)
  return r.value
}

const refusal = (src: string): string => {
  const p = parseExpr(src)
  return p.ok ? '' : p.reason
}

describe('reading expressions', () => {
  it('does arithmetic with the usual order, powers right to left and tighter than a minus', () => {
    expect(value('1 + 2 * 3')).toBe(7)
    expect(value('(1 + 2) * 3')).toBe(9)
    expect(value('2 ^ 3 ^ 2')).toBe(512)
    expect(value('-2 ^ 2')).toBe(-4)
    expect(value('7 % 3')).toBe(1)
    expect(value('-7 % 3')).toBe(2)
    expect(value('1 / 0')).toBe(0)
    expect(value('.5e1')).toBe(5)
  })

  it('compares, chooses with a ternary, and joins with and/or', () => {
    expect(value('time > 1 ? 10 : 20', { time: 2 })).toBe(10)
    expect(value('time > 1 ? 10 : 20', { time: 0.5 })).toBe(20)
    expect(value('time >= 1 && time < 2', { time: 1 })).toBe(1)
    expect(value('!(1 == 2) || 0')).toBe(1)
  })

  it('reads time, value, index and duration', () => {
    expect(value('value + time * 30', { value: 10, time: 2 })).toBe(70)
    expect(value('index * 2', { index: 3 })).toBe(6)
    expect(value('duration', { duration: 4 })).toBe(4)
    expect(value('PI')).toBeCloseTo(Math.PI)
  })

  it('works on vectors element by element, and indexes them', () => {
    expect(value('[1, 2] + [3, 4]')).toEqual([4, 6])
    expect(value('[1, 2] * 3')).toEqual([3, 6])
    expect(value('-[1, 2]')).toEqual([-1, -2])
    expect(value('([1, 2, 3] * 2)[2]')).toBe(6)
    expect(value('value[0]', { value: [5, 9] })).toBe(5)
  })

  it('has the functions it names', () => {
    expect(value('sin(PI / 2) + cos(0) + abs(-2)')).toBeCloseTo(4)
    expect(value('floor(2.7) + round(2.5) + min(4, 2, 9) + max(1, 5)')).toBe(2 + 3 + 2 + 5)
    expect(value('clamp(12, 0, 10)')).toBe(10)
    expect(value('lerp(0, 100, 0.25)')).toBe(25)
    expect(value('linear(time, 0, 2, 0, 100)', { time: 1 })).toBe(50)
    expect(value('linear(time, 0, 2, 0, 100)', { time: 5 })).toBe(100)
    expect(value('ease(time, 0, 2, 0, 100)', { time: 0.5 })).toBeLessThan(25)
    expect(value('linear(0.5, [0, 0], [10, 20])')).toEqual([5, 10])
    const r = value('random(3)') as number
    expect(r).toBeGreaterThanOrEqual(0)
    expect(r).toBeLessThan(1)
    expect(value('random(3)')).toBe(r)
    expect(value('random(4)')).not.toBe(r)
    expect(Math.abs(value('noise(time)', { time: 1.3 }) as number)).toBeLessThanOrEqual(1)
  })

  it('refuses what it cannot read, each in one plain sentence', () => {
    const cases: [string, RegExp][] = [
      ['', /is empty/],
      ['1 +', /ends too soon/],
      ['wiggle(2', /closing "\)" for wiggle/],
      ['foo(1)', /calls foo, which it does not know/],
      ['wiggle(1)', /gives wiggle 1 value, where it takes 2 to 3/],
      ['loopOut("bounce")', /cycle.*pingpong/],
      ['clip(a).x', /uses a, which it does not know/],
      ['clip("a")', /needs a setting after clip\("a"\)/],
      ['clip("a").colour', /reads colour of a clip/],
      ['1 2', /should end/],
      ['[1]', /list of 1/],
      ['x'.repeat(401), /longer than 400/],
      ['1 $ 2', /cannot read/]
    ]
    for (const [src, want] of cases) {
      const said = refusal(src)
      expect(said, src).toMatch(want)
      expect(said.trim().split(/(?<=[.])\s+(?=[A-Z])/)).toHaveLength(1)
      expect(said.endsWith('.')).toBe(true)
    }
  })

  it('says what went wrong when it runs, rather than giving a wrong number', () => {
    const p = parseExpr('value[3]')
    expect(p.ok).toBe(true)
    if (!p.ok) return
    const r = runExpr(p.expr, env({ value: [1, 2] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/a list of 2 has nothing at 3/)
  })
})

describe('an expression stays inside its interpreter', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reads no name, member or call outside its own tables', () => {
    for (const src of [
      'constructor',
      '__proto__',
      'toString()',
      'globalThis',
      'process.exit(1)',
      'window',
      'this',
      'eval("1")',
      'Function("return 1")()',
      'require("fs")',
      '(1).constructor',
      'value.constructor',
      'clip("a").constructor',
      'clip("a").__proto__',
      'hasOwnProperty("x")',
      'valueOf()'
    ]) {
      expect(parseExpr(src).ok, src).toBe(false)
    }
  })

  it('never calls eval or builds a Function, and its source has neither', () => {
    const evalSpy = vi.spyOn(globalThis, 'eval')
    for (const src of ['wiggle(3, 20) + sin(time)', 'linear(time, 0, 1, 0, 10)', 'loopOut("pingpong")', 'clip("a").x * 2'])
      value(src, { time: 1.7, value: 3, keys: { times: [0, 1], at: (t) => t * 10 }, clip: () => 5 })
    expect(evalSpy).not.toHaveBeenCalled()
    const source = readFileSync('src/shared/anim/expr.ts', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    expect(source).not.toMatch(/\beval\s*\(|new\s+Function|\bFunction\s*\(|\bimport\s*\(|\brequire\s*\(|globalThis|window\b/)
    expect(source).not.toMatch(/^import /m)
  })
})

describe('loopOut and wiggle', () => {
  const keys = { times: [0, 1], at: (t: number): number => t * 10 }

  it('loops the keys once they run out, from the start again or back and forth', () => {
    // Inside the keys, the keys' own value.
    expect(value('loopOut()', { time: 0.5, value: 5, keys })).toBe(5)
    expect(value('loopOut("cycle")', { time: 1.25, value: 10, keys })).toBeCloseTo(2.5)
    expect(value('loopOut("cycle")', { time: 3.75, value: 10, keys })).toBeCloseTo(7.5)
    expect(value('loopOut("pingpong")', { time: 1.25, value: 10, keys })).toBeCloseTo(7.5)
    expect(value('loopOut("pingpong")', { time: 2.25, value: 10, keys })).toBeCloseTo(2.5)
    // The same moment gives the same value every time.
    const once = value('loopOut("pingpong")', { time: 5.4321, value: 10, keys })
    for (let i = 0; i < 5; i++) expect(value('loopOut("pingpong")', { time: 5.4321, value: 10, keys })).toBe(once)
  })

  it('wiggles the same way every time, apart for another seed, and within its amount', () => {
    const at = (t: number, seed = 0): number => value(`wiggle(2, 10${seed ? `, ${seed}` : ''})`, { time: t, value: 100 }) as number
    const run = Array.from({ length: 80 }, (_, i) => at(i * 0.05))
    expect(Array.from({ length: 80 }, (_, i) => at(i * 0.05))).toEqual(run)
    expect(Array.from({ length: 80 }, (_, i) => at(i * 0.05, 7))).not.toEqual(run)
    for (const v of run) expect(Math.abs(v - 100)).toBeLessThanOrEqual(10.0001)
    // It moves, and it moves smoothly: no jump between frames bigger than a few pixels.
    expect(Math.max(...run) - Math.min(...run)).toBeGreaterThan(3)
    for (let i = 1; i < run.length; i++) expect(Math.abs(run[i] - run[i - 1])).toBeLessThan(5)
    // Its index seeds it when no seed is given, so two clips wiggle apart.
    expect(value('wiggle(2, 10)', { time: 0.7, value: 0, index: 1 })).not.toBe(value('wiggle(2, 10)', { time: 0.7, value: 0, index: 2 }))
    // A vector wiggles each part on its own.
    const v = value('wiggle(2, 10)', { time: 0.7, value: [0, 0] }) as number[]
    expect(v[0]).not.toBe(v[1])
  })

  it('has noise that is smooth and the same each time', () => {
    expect(noise1(2.5)).toBe(noise1(2.5))
    expect(Math.abs(noise1(3))).toBeLessThan(1e-9)
    expect(Math.abs(noise1(2.51) - noise1(2.5))).toBeLessThan(0.05)
  })
})

describe('checking expressions against each other', () => {
  const clips = [
    { id: 'c1', name: 'Title' },
    { id: 'c2', name: 'Logo' },
    { id: 'c3' }
  ]

  it('takes expressions that read other clips by name or id', () => {
    expect(
      checkExprs(
        [
          { clip: 'c1', path: 'x', source: 'clip("Logo").x + 40' },
          { clip: 'c2', path: 'x', source: 'clip("c3").x' },
          { clip: 'c1', path: 'opacity', source: 'clip("c1").x > 0 ? 1 : 0' }
        ],
        clips
      )
    ).toBeNull()
  })

  it('refuses a circle of readings, however long, and a clip that reads itself', () => {
    const two = checkExprs(
      [
        { clip: 'c1', path: 'x', source: 'clip("Logo").y' },
        { clip: 'c2', path: 'y', source: 'clip("Title").x + 1' }
      ],
      clips
    )
    expect(two).toMatch(/read each other in a circle \(c1\.x reads c2\.y reads c1\.x\)/)
    const three = checkExprs(
      [
        { clip: 'c1', path: 'x', source: 'clip("c2").x' },
        { clip: 'c2', path: 'x', source: 'clip("c3").x' },
        { clip: 'c3', path: 'x', source: 'clip("c1").x' }
      ],
      clips
    )
    expect(three).toMatch(/in a circle/)
    expect(checkExprs([{ clip: 'c1', path: 'x', source: 'clip("Title").x + 1' }], clips)).toMatch(/in a circle/)
  })

  it('refuses a clip that is not there, and a list where a setting takes a number', () => {
    expect(checkExprs([{ clip: 'c1', path: 'x', source: 'clip("Nope").x' }], clips)).toMatch(/there is no clip by that name/)
    expect(checkExprs([{ clip: 'c1', path: 'x', source: '[1, 2]' }], clips)).toMatch(/gives a list, where x takes one number/)
  })
})

describe('expressions on keyed settings', () => {
  it('gives the expression where the keys would be read, with the keys as value', () => {
    expect(num({ keys: [{ t: 0, v: 5 }], expr: 'value * 2' }, 0, 4)).toBe(10)
    expect(num({ keys: [], expr: 'time * 30' }, 2, 4)).toBe(60)
    const looped = { keys: [{ t: 0, v: 0 }, { t: 1, v: 10 }], expr: 'loopOut()' }
    expect(num(looped, 1.5, 4)).toBeCloseTo(5)
    // A colour reads as red, green, blue and alpha from 0 to 1.
    expect(color({ keys: [{ t: 0, v: '#ff0000' }], expr: '[value[2], value[1], value[0], 1]' }, 0, 1)).toBe('rgb(0, 0, 255)')
  })

  it('falls back to the keys when the expression cannot run', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(num({ keys: [{ t: 0, v: 7 }], expr: 'clip("gone").x' }, 0, 1)).toBe(7)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('reads another clip through its binding, at the same moment', () => {
    const bind = { index: 0, clip: (name: string, path: string, local: number) => (name === 'Logo' && path === 'x' ? 100 + local : null) }
    expect(num({ keys: [], expr: 'clip("Logo").x + 1', bind }, 2, 4)).toBe(103)
  })
})
