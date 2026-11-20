import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { readAsk } from '../../shared/make/brief'
import { scriptCost, shotListCost, shotListParts } from '../../shared/make/quote'
import { maybeBilled, parseWith, planShots, writeScript, type ParseCall } from './claude'
import { Budget } from './generate'

/**
 * Re-review of e11324f (claims 4 and 5, and the extra on calls that never left the computer).
 * No real service is called: errors are built as undici and the SDK build them, and the one real
 * request goes to a closed port on this machine (127.0.0.1:59999), so it never leaves it.
 */

const sysErr = (code: string): Error => Object.assign(new Error(code), { code })
const fetchFailed = (cause: unknown): TypeError => Object.assign(new TypeError('fetch failed'), { cause })
const conn = (cause: unknown): Anthropic.APIConnectionError => new Anthropic.APIConnectionError({ message: 'Connection error.', cause: cause as Error })

describe('a call that never left the computer costs nothing; one cut off after it went keeps its hold (extra)', () => {
  it('reads the cause chain as undici builds it', () => {
    const cases: [string, unknown][] = [
      ['ECONNREFUSED', conn(fetchFailed(sysErr('ECONNREFUSED')))],
      ['ENOTFOUND', conn(fetchFailed(sysErr('ENOTFOUND')))],
      ['every address refused (AggregateError)', conn(fetchFailed(Object.assign(new AggregateError([sysErr('ECONNREFUSED'), sysErr('ECONNREFUSED')]), { code: 'ECONNREFUSED' })))],
      ['TLS: CERT_HAS_EXPIRED', conn(fetchFailed(sysErr('CERT_HAS_EXPIRED')))],
      ['TLS: ERR_TLS_CERT_ALTNAME_INVALID', conn(fetchFailed(sysErr('ERR_TLS_CERT_ALTNAME_INVALID')))],
      ['ECONNRESET (after it went)', conn(fetchFailed(sysErr('ECONNRESET')))],
      ['body cut off: terminated / UND_ERR_SOCKET', conn(Object.assign(new TypeError('terminated'), { cause: sysErr('UND_ERR_SOCKET') }))],
      ['ETIMEDOUT', conn(fetchFailed(sysErr('ETIMEDOUT')))],
      ['no cause at all', conn(undefined)]
    ]
    for (const [label, err] of cases) console.log(`${label}: maybeBilled=${maybeBilled(err)}`)
    expect(maybeBilled(cases[0][1])).toBe(false)
    expect(maybeBilled(cases[1][1])).toBe(false)
    expect(maybeBilled(cases[5][1])).toBe(true)
    expect(maybeBilled(cases[6][1])).toBe(true)
  })

  it('a real request to a closed port on this machine, through the SDK as the app builds it: nothing counted', async () => {
    // Not port 1: fetch refuses the spec's "bad ports" with no system code at all ("bad port").
    const parse = parseWith(new Anthropic({ apiKey: 'sk-ant-probe', baseURL: 'http://127.0.0.1:59999', maxRetries: 0 }))
    const brief = readAsk('make a 1 minute documentary about the 1950s oil boom')!
    const budget = new Budget(1)
    const r = await writeScript(brief, parse, { budget })
    let chain = ''
    try {
      await parse({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] } as never)
    } catch (err) {
      let e: unknown = err
      const names: string[] = []
      for (let i = 0; i < 6 && e; i++) {
        names.push(`${(e as Error).constructor?.name}${(e as { code?: string }).code ? `(${(e as { code?: string }).code})` : ''}`)
        e = (e as { cause?: unknown }).cause
      }
      chain = names.join(' <- ')
      console.log(`error chain: ${chain}; maybeBilled=${maybeBilled(err)}`)
    }
    console.log(`writeScript to a closed port: ok=${r.ok} "${!r.ok ? r.message : ''}" cost $${r.cost.toFixed(4)}; budget spent $${budget.spent.toFixed(4)}`)
    expect(r.ok).toBe(false)
    expect(r.cost).toBe(0)
    expect(budget.spent).toBe(0)
  })
})

describe('the shot list held part by part (claim 5)', () => {
  const run = async (n: number, quotedScenes: number, seconds: number, leftover: number, needPerShot: number) => {
    const phrases = Array.from({ length: n }, (_, i) => `In ${1950 + (i % 9)} the derricks rose over town number ${i + 1} and the men worked through the night.`)
    const brief = { ...readAsk('make an 8 minute documentary about the 1950s oil boom, stills only')!, seconds }
    const quoted = shotListCost(quotedScenes, seconds)
    const budget = new Budget(Math.round((quoted + leftover) * 10000) / 10000)
    const calls: string[] = []
    const parse: ParseCall = async (params) => {
      const max = params.max_tokens as number
      const asked = [...JSON.stringify(params.messages).matchAll(/(?:^|\\n)(\d+): /g)].map((m) => Number(m[1]))
      const need = asked.length * needPerShot
      const out = Math.min(max, need)
      calls.push(`${asked.length} phrases: max_tokens ${max}, needs ${need}${need > max ? ' (cut off)' : ''}`)
      return {
        parsed_output:
          need > max
            ? null
            : {
                style: 'Photoreal archival photograph.',
                palette: 'sepia',
                era: '1950s',
                characters: [],
                shots: asked.map((i) => ({ phrase: i, kind: 'still', prompt: `Derrick ${i}.`, move: 'push-in', motion: '', characters: [], place: '', titleBig: '', titleSmall: '', graphic: '', text: [], values: [], items: [], callouts: [] }))
              },
        stop_reason: need > max ? 'max_tokens' : 'end_turn',
        usage: { input_tokens: 3_000, output_tokens: out }
      }
    }
    const r = await planShots(brief, phrases, { sections: [0], outline: [], maxClips: 0, budget, narrationSeconds: seconds }, parse)
    return { r, calls, quoted, budget, holds: shotListParts(n, seconds) }
  }

  it('a script written at make time with more phrases than the quote counted (a made video at a new length)', async () => {
    // 8 minutes: the quote counts 75 phrases (1,120 words at 15 a phrase); sentences of about 12 words make 93.
    for (const [n, need] of [
      [75, 175],
      [93, 175],
      [93, 240],
      [110, 175]
    ] as const) {
      const { r, calls, quoted, budget, holds } = await run(n, 75, 480, 0.07, need)
      console.log(
        `${n} phrases against a shot list quoted for 75 ($${quoted.toFixed(4)}, budget $${budget.cap.toFixed(4)} with $0.07 the script left), ${need} tokens a shot: ` +
          `holds ${holds.map((h) => h.toFixed(4)).join(' + ')}; ${calls.join('; ')}; ok=${r.ok}${r.ok ? '' : ` "${r.message}"`}; spent $${r.cost.toFixed(4)}`
      )
    }
    expect(true).toBe(true)
  })

  it('scriptCost for the lengths the probes use', () => {
    console.log(`scriptCost: 60 s $${scriptCost(60)}, 180 s $${scriptCost(180)}, 480 s $${scriptCost(480)}, 600 s $${scriptCost(600)}, 3600 s $${scriptCost(3600)}`)
    expect(scriptCost(60)).toBeGreaterThan(0)
  })
})
