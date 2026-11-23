/**
 * Expressions: a small language for a setting that moves by a rule rather
 * than by keys alone, the way an After Effects expression does. `wiggle(2,
 * 10)` shakes a title; `value + time * 30` turns it a little more each
 * second; `loopOut("pingpong")` plays its keys back and forth for as long as
 * the clip lasts; `clip("Logo").opacity` follows another clip.
 *
 * It is read by a parser and run by an interpreter written here: there is no
 * eval, no Function, and nothing reaches the page or the process. Names are
 * looked up in tables made without a prototype, members only on a clip
 * reference and only by the settings a clip has, and every call is to a
 * function in this file. Its size is bounded, it has no loops, and a clip's
 * expression reaching back to itself through others is refused when it is
 * set and cut short if it ever runs.
 *
 * It stands alone, importing nothing, so the keyframe engine (motion/anim)
 * can run it where it samples keys.
 */

// ---------- Values ----------

/** A number, or a vector of them (a position, a colour as 0 to 1). */
export type ExprValue = number | number[]

/** What an expression reads besides its own words. */
export interface ExprEnv {
  /** Seconds since the clip began. */
  time: number
  /** The setting as its keys (or its plain value) give it now. */
  value: ExprValue
  /** The clip's place, for seeding a wiggle apart from its neighbours: 0 when nothing says. */
  index?: number
  /** How long the clip lasts, in seconds. */
  duration?: number
  /** The setting's keys, for loopOut: their times, and the value they give at a time. */
  keys?: { times: number[]; at: (t: number) => ExprValue }
  /** Another clip's setting at this moment, by its name or id and the setting's path ("opacity", "crop.left"). */
  clip?: (name: string, path: string) => ExprValue | null
}

/** A parsed expression, ready to run as often as needed. */
export interface Expr {
  readonly source: string
  readonly root: Node
  /** The other clips' settings it reads: name and path. */
  readonly refs: readonly { name: string; path: string }[]
}

// ---------- The tree ----------

type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'name'; name: string }
  | { k: 'vec'; items: Node[] }
  | { k: 'neg'; arg: Node }
  | { k: 'not'; arg: Node }
  | { k: 'bin'; op: BinOp; a: Node; b: Node }
  | { k: 'if'; test: Node; then: Node; else: Node }
  | { k: 'call'; fn: string; args: Node[] }
  | { k: 'index'; of: Node; at: Node }
  | { k: 'ref'; name: string; path: string }

type BinOp = '+' | '-' | '*' | '/' | '%' | '^' | '<' | '>' | '<=' | '>=' | '==' | '!=' | '&&' | '||'

/** Longer than this is a program, not an expression. */
export const MAX_EXPR_CHARS = 400
const MAX_NODES = 240
const MAX_DEPTH = 40
const MAX_VECTOR = 4
/** How deep clip references may chain before the chain is cut short. */
export const MAX_REF_DEPTH = 8

/** The words an expression may read. */
const NAMES: Record<string, true> = Object.assign(Object.create(null) as Record<string, true>, {
  time: true,
  value: true,
  index: true,
  duration: true,
  PI: true
})

/** The settings a clip reference may name, by path. */
const CLIP_PATHS: Record<string, true> = Object.assign(Object.create(null) as Record<string, true>, {
  x: true,
  y: true,
  anchorX: true,
  anchorY: true,
  scale: true,
  scaleX: true,
  scaleY: true,
  rotation: true,
  skewX: true,
  skewY: true,
  opacity: true,
  'crop.left': true,
  'crop.top': true,
  'crop.right': true,
  'crop.bottom': true,
  volume: true
})

/** Each function's name and how many arguments it takes. */
const ARITY: Record<string, [number, number]> = Object.assign(Object.create(null) as Record<string, [number, number]>, {
  sin: [1, 1],
  cos: [1, 1],
  tan: [1, 1],
  abs: [1, 1],
  floor: [1, 1],
  round: [1, 1],
  min: [1, 8],
  max: [1, 8],
  clamp: [3, 3],
  lerp: [3, 3],
  linear: [3, 5],
  ease: [3, 5],
  wiggle: [2, 3],
  random: [1, 1],
  noise: [1, 1],
  loopOut: [0, 1],
  clip: [1, 1]
})

/** The function names, for the guide and the editor. */
export const EXPR_FUNCTIONS = Object.keys(ARITY).filter((f) => f !== 'clip')

// ---------- Reading ----------

class Unreadable extends Error {}

type Tok =
  | { t: 'num'; v: number; at: number }
  | { t: 'str'; v: string; at: number }
  | { t: 'id'; v: string; at: number }
  | { t: 'op'; v: string; at: number }
  | { t: 'end'; at: number }

const OPS = ['<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '%', '^', '(', ')', '[', ']', ',', '.', '?', ':', '<', '>', '!']

function tokens(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))
    if (number) {
      out.push({ t: 'num', v: Number(number[0]), at: i })
      i += number[0].length
      continue
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))
    if (word) {
      out.push({ t: 'id', v: word[0], at: i })
      i += word[0].length
      continue
    }
    if (c === '"' || c === "'") {
      const close = src.indexOf(c, i + 1)
      if (close < 0) throw new Unreadable('has a quote that is never closed')
      const text = src.slice(i + 1, close)
      if (text.length > 60) throw new Unreadable('has a name in quotes longer than a clip name can be')
      out.push({ t: 'str', v: text, at: i })
      i = close + 1
      continue
    }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (!op) throw new Unreadable(`has ${JSON.stringify(c)}, which it cannot read`)
    out.push({ t: 'op', v: op, at: i })
    i += op.length
  }
  out.push({ t: 'end', at: src.length })
  return out
}

/** A recursive-descent reader over the tokens, counting nodes and depth as it goes. */
class Reader {
  private i = 0
  private nodes = 0
  private depth = 0
  readonly refs: { name: string; path: string }[] = []

  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok {
    return this.toks[this.i]
  }

  private isOp(v: string): boolean {
    const t = this.peek()
    return t.t === 'op' && t.v === v
  }

  /** Takes the token `v`, called `what` ("closing ")" for wiggle") in the sentence when it is not there. */
  private take(v: string, what: string): void {
    if (!this.isOp(v)) {
      const t = this.peek()
      throw new Unreadable(t.t === 'end' ? `ends before its ${what}` : `needs its ${what} where it has ${describeTok(t)}`)
    }
    this.i++
  }

  private node<N extends Node>(n: N): N {
    if (++this.nodes > MAX_NODES) throw new Unreadable('is too long to run every frame')
    return n
  }

  private deeper<T>(read: () => T): T {
    if (++this.depth > MAX_DEPTH) throw new Unreadable('nests too deeply')
    try {
      return read()
    } finally {
      this.depth--
    }
  }

  whole(): Node {
    const root = this.expr()
    const t = this.peek()
    if (t.t !== 'end') throw new Unreadable(`has ${describeTok(t)} where it should end`)
    return root
  }

  private expr(): Node {
    return this.deeper(() => {
      const test = this.or()
      if (!this.isOp('?')) return test
      this.i++
      const then = this.expr()
      this.take(':', '":" after the "?"')
      const otherwise = this.expr()
      return this.node({ k: 'if', test, then, else: otherwise })
    })
  }

  private binary(next: () => Node, ops: BinOp[]): Node {
    let a = next()
    for (;;) {
      const t = this.peek()
      if (t.t !== 'op' || !ops.includes(t.v as BinOp)) return a
      this.i++
      const b = next()
      a = this.node({ k: 'bin', op: t.v as BinOp, a, b })
    }
  }

  private or(): Node {
    return this.binary(() => this.and(), ['||'])
  }

  private and(): Node {
    return this.binary(() => this.compare(), ['&&'])
  }

  private compare(): Node {
    return this.binary(() => this.sum(), ['<', '>', '<=', '>=', '==', '!='])
  }

  private sum(): Node {
    return this.binary(() => this.product(), ['+', '-'])
  }

  private product(): Node {
    return this.binary(() => this.unary(), ['*', '/', '%'])
  }

  private unary(): Node {
    return this.deeper(() => {
      if (this.isOp('-')) {
        this.i++
        return this.node({ k: 'neg', arg: this.unary() })
      }
      if (this.isOp('+')) {
        this.i++
        return this.unary()
      }
      if (this.isOp('!')) {
        this.i++
        return this.node({ k: 'not', arg: this.unary() })
      }
      return this.power()
    })
  }

  /** Right to left, and tighter than a minus before it: -2^2 is -4. */
  private power(): Node {
    const base = this.postfix()
    if (!this.isOp('^')) return base
    this.i++
    return this.node({ k: 'bin', op: '^', a: base, b: this.unary() })
  }

  private postfix(): Node {
    let n = this.primary()
    while (this.isOp('[')) {
      this.i++
      const at = this.expr()
      this.take(']', 'closing "]"')
      n = this.node({ k: 'index', of: n, at })
    }
    if (this.isOp('.')) throw new Unreadable('has a "." that only follows clip("name")')
    return n
  }

  private primary(): Node {
    const t = this.peek()
    if (t.t === 'num') {
      this.i++
      if (!Number.isFinite(t.v)) throw new Unreadable('has a number too large to use')
      return this.node({ k: 'num', v: t.v })
    }
    if (t.t === 'str') {
      this.i++
      return this.node({ k: 'str', v: t.v })
    }
    if (t.t === 'op' && t.v === '(') {
      this.i++
      const inner = this.expr()
      this.take(')', 'closing ")"')
      return inner
    }
    if (t.t === 'op' && t.v === '[') {
      this.i++
      const items: Node[] = []
      if (!this.isOp(']')) {
        for (;;) {
          items.push(this.expr())
          if (!this.isOp(',')) break
          this.i++
        }
      }
      this.take(']', 'closing "]"')
      if (items.length < 2 || items.length > MAX_VECTOR) throw new Unreadable(`has a list of ${items.length}, where a list holds 2 to ${MAX_VECTOR} numbers`)
      return this.node({ k: 'vec', items })
    }
    if (t.t === 'id') {
      this.i++
      if (this.isOp('(')) return this.call(t.v)
      if (!(t.v in NAMES)) throw new Unreadable(`uses ${t.v}, which it does not know`)
      return this.node({ k: 'name', name: t.v })
    }
    throw new Unreadable(t.t === 'end' ? 'ends too soon' : `has ${describeTok(t)} where a value should be`)
  }

  private call(fn: string): Node {
    const arity = ARITY[fn]
    if (!arity) throw new Unreadable(`calls ${fn}, which it does not know`)
    this.take('(', `"(" after ${fn}`)
    const args: Node[] = []
    if (!this.isOp(')')) {
      for (;;) {
        args.push(this.expr())
        if (!this.isOp(',')) break
        this.i++
      }
    }
    this.take(')', `closing ")" for ${fn}`)
    if (args.length < arity[0] || args.length > arity[1]) {
      const want = arity[0] === arity[1] ? `${arity[0]}` : `${arity[0]} to ${arity[1]}`
      throw new Unreadable(`gives ${fn} ${args.length} ${args.length === 1 ? 'value' : 'values'}, where it takes ${want}`)
    }
    if (fn === 'clip') return this.clipRef(args[0])
    if (fn === 'loopOut' && args[0] && (args[0].k !== 'str' || (args[0].v !== 'cycle' && args[0].v !== 'pingpong')))
      throw new Unreadable('gives loopOut something other than "cycle" or "pingpong"')
    for (const [i, a] of args.entries()) if (a.k === 'str' && !(fn === 'loopOut' && i === 0)) throw new Unreadable(`gives ${fn} words where it takes a number`)
    return this.node({ k: 'call', fn, args })
  }

  /** clip("name").setting: a name in quotes, then the setting it reads. */
  private clipRef(arg: Node): Node {
    if (arg.k !== 'str' || !arg.v.trim()) throw new Unreadable('gives clip() something other than a name in quotes')
    const path: string[] = []
    while (this.isOp('.')) {
      this.i++
      const t = this.peek()
      if (t.t !== 'id') throw new Unreadable('needs a setting after the "." of clip()')
      this.i++
      path.push(t.v)
    }
    const joined = path.join('.')
    if (!joined) throw new Unreadable(`needs a setting after clip("${arg.v}"), such as .opacity`)
    if (!(joined in CLIP_PATHS)) throw new Unreadable(`reads ${joined} of a clip, which a clip does not have`)
    const ref = { name: arg.v.trim(), path: joined }
    if (!this.refs.some((r) => r.name === ref.name && r.path === ref.path)) this.refs.push(ref)
    return this.node({ k: 'ref', ...ref })
  }
}

function describeTok(t: Tok): string {
  if (t.t === 'end') return 'its end'
  if (t.t === 'num') return `the number ${t.v}`
  if (t.t === 'str') return `"${t.v}"`
  return `"${t.v}"`
}

const read = new Map<string, Expr | string>()

/**
 * An expression read, or a sentence saying why it cannot be: `The expression
 * "wiggle(2" ends before its closing ")" for wiggle.` Kept once read.
 */
export function parseExpr(source: string): { ok: true; expr: Expr } | { ok: false; reason: string } {
  const src = source.trim()
  const kept = read.get(src)
  if (kept !== undefined) return typeof kept === 'string' ? { ok: false, reason: kept } : { ok: true, expr: kept }
  let result: Expr | string
  if (!src) result = 'The expression is empty.'
  else if (src.length > MAX_EXPR_CHARS) result = `The expression is longer than ${MAX_EXPR_CHARS} characters.`
  else {
    try {
      const reader = new Reader(tokens(src))
      const root = reader.whole()
      result = { source: src, root, refs: reader.refs }
    } catch (err) {
      if (!(err instanceof Unreadable)) throw err
      result = `The expression ${quote(src)} ${err.message}.`
    }
  }
  if (read.size > 500) read.clear()
  read.set(src, result)
  return typeof result === 'string' ? { ok: false, reason: result } : { ok: true, expr: result }
}

const quote = (src: string): string => `"${src.length > 60 ? `${src.slice(0, 57)}...` : src}"`

// ---------- Running ----------

class Failed extends Error {}
const fail = (why: string): never => {
  throw new Failed(why)
}

const isVec = (v: ExprValue): v is number[] => Array.isArray(v)

function numberOf(v: ExprValue, what: string): number {
  if (isVec(v)) return fail(`${what} needs one number, not a list`)
  return v
}

/** Element by element, a number spread across a list. */
function zip(a: ExprValue, b: ExprValue, f: (x: number, y: number) => number, what: string): ExprValue {
  if (!isVec(a) && !isVec(b)) return f(a, b)
  if (isVec(a) && isVec(b)) {
    if (a.length !== b.length) fail(`${what} needs lists of the same length`)
    return a.map((x, i) => f(x, b[i]))
  }
  return isVec(a) ? a.map((x) => f(x, b as number)) : (b as number[]).map((y) => f(a as number, y))
}

const each = (v: ExprValue, f: (x: number) => number): ExprValue => (isVec(v) ? v.map(f) : f(v))

const truthy = (v: ExprValue): boolean => (isVec(v) ? v.some((x) => x !== 0) : v !== 0 && !Number.isNaN(v))

// Deterministic noise: a hash of integers, smooth gradient noise between them.
function hash(n: number): number {
  let h = Math.imul(n | 0, 0x27d4eb2d) ^ 0x165667b1
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** A seed of any number as an integer: 1.5 and 1 seed differently. */
const seedOf = (s: number): number => Math.round(s * 1000) | 0

/** 0 to 1, the same for the same seed every time. */
export function random01(seed: number): number {
  return hash(seedOf(seed) ^ 0x5bd1e995)
}

/** Smooth noise from -1 to 1, the same at the same t and seed every time. */
export function noise1(t: number, seed = 0): number {
  const i = Math.floor(t)
  const f = t - i
  const s = seedOf(seed) * 7919
  const g0 = hash(i * 374761393 + s) * 2 - 1
  const g1 = hash((i + 1) * 374761393 + s) * 2 - 1
  // Gradients at the integers, blended by a quintic so speed and its change are both smooth.
  const v0 = g0 * f
  const v1 = g1 * (f - 1)
  const u = f * f * f * (f * (f * 6 - 15) + 10)
  return Math.max(-1, Math.min(1, (v0 + (v1 - v0) * u) * 2))
}

/** After Effects' wiggle: noise at freq wiggles a second, amp either way, with a second, finer octave at half the strength. */
function wiggleAt(t: number, freq: number, amp: number, seed: number): number {
  const x = t * freq
  return amp * (noise1(x, seed) * 0.8 + noise1(x * 2 + 17.3, seed + 0.5) * 0.4) / 1.2
}

function mapRange(t: number, t0: number, t1: number, v0: ExprValue, v1: ExprValue, shape: (p: number) => number): ExprValue {
  const span = t1 - t0
  const p = Math.abs(span) < 1e-9 ? (t >= t1 ? 1 : 0) : Math.min(1, Math.max(0, (t - t0) / span))
  const k = shape(p)
  return zip(v0, v1, (a, b) => a + (b - a) * k, 'linear')
}

const smooth = (p: number): number => p * p * (3 - 2 * p)

interface Run {
  env: ExprEnv
}

function evaluate(n: Node, run: Run): ExprValue {
  switch (n.k) {
    case 'num':
      return n.v
    case 'str':
      return fail('words are only for clip() and loopOut()')
    case 'name': {
      const e = run.env
      if (n.name === 'time') return e.time
      if (n.name === 'value') return isVec(e.value) ? [...e.value] : e.value
      if (n.name === 'index') return e.index ?? 0
      if (n.name === 'duration') return e.duration ?? 0
      return Math.PI
    }
    case 'vec':
      return n.items.map((item) => numberOf(evaluate(item, run), 'A list'))
    case 'neg':
      return each(evaluate(n.arg, run), (x) => -x)
    case 'not':
      return truthy(evaluate(n.arg, run)) ? 0 : 1
    case 'if':
      return truthy(evaluate(n.test, run)) ? evaluate(n.then, run) : evaluate(n.else, run)
    case 'index': {
      const of = evaluate(n.of, run)
      const at = Math.floor(numberOf(evaluate(n.at, run), 'An index'))
      if (!isVec(of)) return fail('only a list can be indexed')
      if (at < 0 || at >= of.length) return fail(`a list of ${of.length} has nothing at ${at}`)
      return of[at]
    }
    case 'ref': {
      const v = run.env.clip?.(n.name, n.path)
      if (v === null || v === undefined) return fail(`there is no clip called ${n.name}`)
      return v
    }
    case 'bin':
      return binary(n.op, n.a, n.b, run)
    case 'call':
      return call(n.fn, n.args, run)
  }
}

function binary(op: BinOp, an: Node, bn: Node, run: Run): ExprValue {
  if (op === '&&') return truthy(evaluate(an, run)) && truthy(evaluate(bn, run)) ? 1 : 0
  if (op === '||') return truthy(evaluate(an, run)) || truthy(evaluate(bn, run)) ? 1 : 0
  const a = evaluate(an, run)
  const b = evaluate(bn, run)
  switch (op) {
    case '+':
      return zip(a, b, (x, y) => x + y, 'Adding')
    case '-':
      return zip(a, b, (x, y) => x - y, 'Taking away')
    case '*':
      return zip(a, b, (x, y) => x * y, 'Multiplying')
    case '/':
      return zip(a, b, (x, y) => (y === 0 ? 0 : x / y), 'Dividing')
    case '%':
      return zip(a, b, (x, y) => (y === 0 ? 0 : x - y * Math.floor(x / y)), 'A remainder')
    case '^':
      return zip(a, b, (x, y) => Math.pow(x, y), 'A power')
    case '==':
      return isVec(a) || isVec(b) ? (JSON.stringify(a) === JSON.stringify(b) ? 1 : 0) : a === b ? 1 : 0
    case '!=':
      return isVec(a) || isVec(b) ? (JSON.stringify(a) === JSON.stringify(b) ? 0 : 1) : a !== b ? 1 : 0
    default: {
      const x = numberOf(a, 'A comparison')
      const y = numberOf(b, 'A comparison')
      return (op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y) ? 1 : 0
    }
  }
}

function call(fn: string, argNodes: Node[], run: Run): ExprValue {
  if (fn === 'loopOut') {
    const kind = argNodes[0]?.k === 'str' ? argNodes[0].v : 'cycle'
    return loopOut(kind === 'pingpong' ? 'pingpong' : 'cycle', run.env)
  }
  const args = argNodes.map((a) => evaluate(a, run))
  const n = (i: number): number => numberOf(args[i], fn)
  switch (fn) {
    case 'sin':
      return each(args[0], Math.sin)
    case 'cos':
      return each(args[0], Math.cos)
    case 'tan':
      return each(args[0], Math.tan)
    case 'abs':
      return each(args[0], Math.abs)
    case 'floor':
      return each(args[0], Math.floor)
    case 'round':
      return each(args[0], Math.round)
    case 'min':
    case 'max': {
      const pick = fn === 'min' ? Math.min : Math.max
      return args.length === 1 ? (isVec(args[0]) ? pick(...args[0]) : args[0]) : args.reduce((acc, v) => zip(acc, v, pick, fn))
    }
    case 'clamp':
      return zip(zip(args[0], args[1], (x, lo) => Math.max(x, lo), 'clamp'), args[2], (x, hi) => Math.min(x, hi), 'clamp')
    case 'lerp':
      return zip(args[0], args[1], (a, b) => a + (b - a) * n(2), 'lerp')
    case 'linear':
    case 'ease': {
      const shape = fn === 'ease' ? smooth : (p: number): number => p
      if (args.length === 3) return mapRange(n(0), 0, 1, args[1], args[2], shape)
      if (args.length === 5) return mapRange(n(0), n(1), n(2), args[3], args[4], shape)
      return fail(`${fn} takes 3 or 5 values`)
    }
    case 'wiggle': {
      const freq = n(0)
      const amp = n(1)
      const seed = args.length > 2 ? n(2) : (run.env.index ?? 0)
      const t = run.env.time
      const v = run.env.value
      return isVec(v) ? v.map((x, i) => x + wiggleAt(t, freq, amp, seed + i * 101)) : v + wiggleAt(t, freq, amp, seed)
    }
    case 'random':
      return random01(n(0))
    case 'noise':
      return noise1(n(0))
  }
  return fail(`${fn} is not a function`)
}

/** The keys played again once they run out: from the first again, or back and forth. */
function loopOut(kind: 'cycle' | 'pingpong', env: ExprEnv): ExprValue {
  const keys = env.keys
  if (!keys || keys.times.length < 2) return env.value
  const first = Math.min(...keys.times)
  const last = Math.max(...keys.times)
  const span = last - first
  const t = env.time
  if (t <= last || span < 1e-6) return env.value
  const k = (t - first) / span
  const turn = Math.floor(k)
  const frac = k - turn
  const p = kind === 'pingpong' && turn % 2 === 1 ? 1 - frac : frac
  return keys.at(first + p * span)
}

/** The expression's value, or a sentence saying why it could not run. */
export function runExpr(expr: Expr, env: ExprEnv): { ok: true; value: ExprValue } | { ok: false; reason: string } {
  try {
    const v = evaluate(expr.root, { env })
    const bad = isVec(v) ? v.some((x) => !Number.isFinite(x)) : !Number.isFinite(v)
    if (bad) return { ok: false, reason: `The expression ${quote(expr.source)} gives no number at ${env.time.toFixed(2)} s.` }
    return { ok: true, value: v }
  } catch (err) {
    if (err instanceof Failed) return { ok: false, reason: `The expression ${quote(expr.source)} cannot run: ${err.message}.` }
    if (err instanceof RangeError) return { ok: false, reason: `The expression ${quote(expr.source)} reaches too deep.` }
    throw err
  }
}

// ---------- Checking ----------

/** A setting's expressions, by the clip they sit on and the setting: what checkExprs reads. */
export interface ExprSite {
  clip: string
  /** Its name as other clips' expressions call it. */
  name?: string
  path: string
  source: string
}

/**
 * Why a set of expressions cannot stand, or null: one that does not read, one
 * that reads a clip there is none of, one that gives a list where a setting
 * takes a number, or a chain of them that reads back into itself. With
 * `focus`, only the sites it picks are held to the first three (the ones a
 * change touched), so a clip left reading one since taken away does not
 * stop every other change; a circle is a circle wherever it is.
 */
export function checkExprs(sites: ExprSite[], clips: { id: string; name?: string }[], focus?: (site: ExprSite) => boolean): string | null {
  const parsed = new Map<string, Expr>()
  const key = (clip: string, path: string): string => `${clip}\u0000${path}`
  const idOf = (name: string): string | null => clips.find((c) => c.id === name)?.id ?? clips.find((c) => c.name === name)?.id ?? null
  for (const s of sites) {
    const r = parseExpr(s.source)
    const held = !focus || focus(s)
    if (!r.ok) {
      if (held) return r.reason
      continue
    }
    if (!held) {
      parsed.set(key(s.clip, s.path), r.expr)
      continue
    }
    for (const ref of r.expr.refs) if (!idOf(ref.name)) return `The expression ${quote(r.expr.source)} reads clip "${ref.name}", and there is no clip by that name.`
    // A trial run with neutral readings: it must give one number.
    const trial = runExpr(r.expr, { time: 0.5, value: 0, index: 0, duration: 1, clip: () => 0 })
    if (!trial.ok) return trial.reason
    if (Array.isArray(trial.value)) return `The expression ${quote(r.expr.source)} gives a list, where ${s.path} takes one number.`
    parsed.set(key(s.clip, s.path), r.expr)
  }
  // A path round the readings that comes back to where it began.
  const state = new Map<string, 'open' | 'done'>()
  const visit = (at: string, trail: string[]): string | null => {
    if (state.get(at) === 'done') return null
    if (state.get(at) === 'open') {
      const from = trail.indexOf(at)
      const loop = [...trail.slice(from), at].map((k) => k.replace('\u0000', '.'))
      return `Those expressions read each other in a circle (${loop.join(' reads ')}), so none of them could be worked out.`
    }
    state.set(at, 'open')
    const e = parsed.get(at)
    for (const ref of e?.refs ?? []) {
      const id = idOf(ref.name)
      if (!id) continue
      const found = visit(key(id, ref.path), [...trail, at])
      if (found) return found
    }
    state.set(at, 'done')
    return null
  }
  for (const k of parsed.keys()) {
    const found = visit(k, [])
    if (found) return found
  }
  return null
}
