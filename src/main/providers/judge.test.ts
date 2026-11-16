import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { checkGemini, fromGemini, GEMINI_MAX_INLINE_BYTES, JUDGE_SYSTEM, VERDICT_JSON_SCHEMA } from './gemini'
import { ServiceError } from './gate'
import { judgeExcerpts, type ExcerptClip, type JudgeDeps } from './judge'
import type { Excerpt } from './media'
import { gateFor, json, scriptedFetch, type Answer } from './testing'

const root = mkdtempSync(join(tmpdir(), 'cutalong-judge-test-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const KEY = { gemini: 'AIza-test-key-0123' }
const TAKES: ExcerptClip[] = [
  { sourcePath: '/Users/you/Movies/take-1.mov', startSec: 10, endSec: 14.5 },
  { sourcePath: '/Users/you/Movies/take-2.mov', startSec: 3, endSec: 8 }
]

/** Writes a small stand-in excerpt and says what it wrote, so the request can be checked byte for byte. */
function fakeCutter(): { cut: NonNullable<JudgeDeps['cut']>; spy: ReturnType<typeof vi.fn>; bytes: Buffer[] } {
  const bytes: Buffer[] = []
  const spy = vi.fn(async (_ffmpeg: string, clip: ExcerptClip, out: string): Promise<Excerpt> => {
    const data = Buffer.from(`mp4 bytes for ${clip.sourcePath} ${clip.startSec}-${clip.endSec}`)
    writeFileSync(out, data)
    bytes.push(data)
    return { path: out, bytes: data.length, durationSec: clip.endSec - clip.startSec }
  })
  return { cut: (f, c, o) => spy(f, c, o), spy, bytes }
}

/**
 * A generateContent reply in the shape the API reference documents
 * (candidates, content.parts, finishReason, usageMetadata, modelVersion),
 * carrying the JSON the schema asks for.
 */
function geminiReply(verdict: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidates: [
      {
        content: { parts: [{ text: JSON.stringify(verdict) }], role: 'model' },
        finishReason: 'STOP',
        index: 0,
        ...extra
      }
    ],
    usageMetadata: { promptTokenCount: 5120, candidatesTokenCount: 140, totalTokenCount: 5260 },
    modelVersion: 'gemini-flash-latest',
    responseId: 'resp-1'
  }
}

const VERDICT = {
  // Out of order on purpose: the answer is put back in the order the clips were given.
  clips: [
    { clip: 2, answer: 'Clear and steady, and the line lands.', score: 8, problems: [] },
    {
      clip: 1,
      answer: 'The energy drops halfway and focus hunts on your face.',
      score: 4.5,
      problems: ['focus hunts at 0:02', ' restarts the line at 0:03 ', '']
    }
  ],
  best: 2,
  summary: 'Clip 2 is the take to keep.'
}

function deps(answers: Answer[], opts: { on?: boolean; keys?: Record<string, string> } = {}) {
  const { fetch, sent, spy } = scriptedFetch(answers)
  const cutter = fakeCutter()
  const tempDir = mkdtempSync(join(root, 'run-'))
  const d: JudgeDeps = {
    gate: gateFor(fetch, { on: opts.on ?? true, keys: opts.keys ?? KEY }),
    ffmpeg: 'ffmpeg',
    tempDir,
    cut: cutter.cut
  }
  return { d, sent, fetchSpy: spy, cutter, tempDir }
}

const QUESTION = 'Which take is delivered best, and why?'

describe('judging excerpts with Google Gemini', () => {
  it('sends the documented generateContent request: each excerpt inline after its label, then the question', async () => {
    const { d, sent, cutter } = deps([() => json(geminiReply(VERDICT))])
    await judgeExcerpts({ clips: TAKES, question: QUESTION }, d)
    expect(sent).toHaveLength(1)
    const [req] = sent
    expect(req.method).toBe('POST')
    expect(req.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent')
    expect(req.headers.get('x-goog-api-key')).toBe('AIza-test-key-0123')
    expect(req.headers.get('content-type')).toBe('application/json')
    const body = JSON.parse(req.text as string)
    expect(body.systemInstruction).toEqual({ parts: [{ text: JUDGE_SYSTEM }] })
    expect(body.generationConfig).toEqual({
      responseMimeType: 'application/json',
      responseJsonSchema: VERDICT_JSON_SCHEMA
    })
    expect(body.contents).toHaveLength(1)
    expect(body.contents[0].role).toBe('user')
    expect(body.contents[0].parts).toEqual([
      { text: 'Clip 1, 4.5 s:' },
      { inlineData: { mimeType: 'video/mp4', data: cutter.bytes[0].toString('base64') } },
      { text: 'Clip 2, 5.0 s:' },
      { inlineData: { mimeType: 'video/mp4', data: cutter.bytes[1].toString('base64') } },
      { text: `<question>\n${QUESTION}\n</question>\nAnswer for each of the 2 clips.` }
    ])
    // The recordings' names stay on this computer.
    expect(req.text).not.toContain('take-1.mov')
  })

  it('answers per clip, in the order the clips were given', async () => {
    const { d, tempDir } = deps([() => json(geminiReply(VERDICT))])
    const r = await judgeExcerpts({ clips: TAKES, question: QUESTION }, d)
    expect(r).toEqual({
      ok: true,
      service: 'gemini',
      summary: 'Clip 2 is the take to keep.',
      best: 1,
      clips: [
        {
          ...TAKES[0],
          answer: 'The energy drops halfway and focus hunts on your face.',
          score: 4.5,
          problems: ['focus hunts at 0:02', 'restarts the line at 0:03'],
          best: false
        },
        { ...TAKES[1], answer: 'Clear and steady, and the line lands.', score: 8, problems: [], best: true }
      ]
    })
    // The excerpts are gone once the answer is back.
    expect(readdirSync(tempDir)).toEqual([])
  })

  it('switch off, with a key: cuts nothing and sends nothing', async () => {
    const { d, fetchSpy, cutter } = deps([], { on: false })
    expect(await judgeExcerpts({ clips: TAKES, question: QUESTION }, d)).toEqual({
      ok: false,
      reason: 'off',
      message: 'Other AI services are off in Settings.'
    })
    expect(cutter.spy).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('switch on, no key: cuts nothing and sends nothing', async () => {
    const { d, fetchSpy, cutter } = deps([], { keys: {} })
    expect(await judgeExcerpts({ clips: TAKES, question: QUESTION }, d)).toEqual({
      ok: false,
      reason: 'no-key',
      message: 'There is no Google Gemini key in Settings.'
    })
    expect(cutter.spy).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('switch on with only another service’s key: sends nothing to anyone', async () => {
    const { d, fetchSpy } = deps([], { keys: { deepgram: 'dg-0123456789' } })
    expect((await judgeExcerpts({ clips: TAKES, question: QUESTION }, d)).ok).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('turns away a request it cannot judge before cutting anything', async () => {
    const { d, fetchSpy, cutter } = deps([])
    const cases: [Parameters<typeof judgeExcerpts>[0], string][] = [
      [{ clips: TAKES, question: '  ' }, 'Ask a question about the clips.'],
      [{ clips: [], question: QUESTION }, 'Give me between 1 and 10 clips to judge.'],
      [{ clips: Array(11).fill(TAKES[0]), question: QUESTION }, 'Give me between 1 and 10 clips to judge.'],
      [{ clips: [{ ...TAKES[0], endSec: 9 }], question: QUESTION }, 'Clip 1 needs an end after its start.'],
      [
        { clips: [TAKES[0], { ...TAKES[1], endSec: 78 }], question: QUESTION },
        'Clip 2 runs 75 s, and I judge stretches of up to 60 s.'
      ]
    ]
    for (const [input, message] of cases) {
      expect(await judgeExcerpts(input, d)).toEqual({ ok: false, reason: 'invalid', message })
    }
    expect(cutter.spy).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sends nothing when the excerpts come to more than it sends at once', async () => {
    const { d, fetchSpy } = deps([])
    d.cut = async (_f, clip, out) => {
      writeFileSync(out, 'x')
      return { path: out, bytes: GEMINI_MAX_INLINE_BYTES / 2 + 1, durationSec: clip.endSec - clip.startSec }
    }
    const r = await judgeExcerpts({ clips: TAKES, question: QUESTION }, d)
    expect(r).toEqual({
      ok: false,
      reason: 'too-big',
      message: 'The excerpts come to 14.0 MB, more than the 14 MB I send to Google Gemini at once.'
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('names a refused key, a rate limit and a refusal to judge', async () => {
    const ask = async (answer: Answer) => judgeExcerpts({ clips: TAKES, question: QUESTION }, deps([answer]).d)
    expect(
      await ask(() =>
        json(
          {
            error: {
              code: 400,
              message: 'API key not valid. Please pass a valid API key.',
              status: 'INVALID_ARGUMENT',
              details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }]
            }
          },
          400
        )
      )
    ).toEqual({ ok: false, reason: 'refused', message: 'Google Gemini did not accept the key.' })
    expect(
      await ask(() =>
        json({ error: { code: 429, message: 'Resource has been exhausted.', status: 'RESOURCE_EXHAUSTED' } }, 429)
      )
    ).toEqual({ ok: false, reason: 'busy', message: 'Google Gemini is busy right now.' })
    expect(await ask(() => json({ promptFeedback: { blockReason: 'SAFETY' } }))).toEqual({
      ok: false,
      reason: 'declined',
      message: 'Google Gemini declined to judge these clips.'
    })
  })

  it('says so when the answer is cut off or not the shape it asked for', () => {
    const fails = (body: unknown): ServiceError => {
      try {
        fromGemini(body, 2)
      } catch (err) {
        return err as ServiceError
      }
      throw new Error('expected a failure')
    }
    expect(fails(geminiReply(VERDICT, { finishReason: 'MAX_TOKENS' })).message).toBe(
      'Google Gemini ran out of room before it finished.'
    )
    expect(fails(geminiReply(VERDICT, { finishReason: 'SAFETY' })).kind).toBe('declined')
    expect(fails({ candidates: [{ content: { parts: [{ text: '{"clips": [' }] } }] }).kind).toBe('unreadable')
    expect(fails(geminiReply({ ...VERDICT, clips: VERDICT.clips.slice(0, 1) })).kind).toBe('unreadable')
    expect(fails(geminiReply({ ...VERDICT, clips: [VERDICT.clips[0], VERDICT.clips[0]] })).kind).toBe('unreadable')
    expect(fails({ candidates: [] }).kind).toBe('unreadable')
    expect(fails('not even an object').kind).toBe('unreadable')
  })

  it('leaves out the model’s thinking, keeps scores in range and ignores a best clip that does not exist', () => {
    const v = fromGemini(
      {
        candidates: [
          {
            content: {
              parts: [
                { text: 'Comparing the two takes first.', thought: true },
                {
                  text: JSON.stringify({
                    clips: [
                      { clip: 1, answer: 'Fine.', score: 14, problems: [] },
                      { clip: 2, answer: 'Rushed.', score: -2, problems: [] }
                    ],
                    best: 7,
                    summary: 'Neither stands out.'
                  })
                }
              ]
            },
            finishReason: 'STOP'
          }
        ]
      },
      2
    )
    expect(v.clips.map((c) => c.score)).toEqual([10, 0])
    expect(v.best).toBeNull()
  })

  it('checks a key with a request that costs nothing', async () => {
    const { fetch, sent } = scriptedFetch([
      () =>
        json({
          name: 'models/gemini-flash-latest',
          displayName: 'Gemini Flash Latest',
          supportedGenerationMethods: ['generateContent']
        })
    ])
    await checkGemini(gateFor(fetch, { keys: KEY }))
    expect(sent.map((r) => [r.method, r.url, r.headers.get('x-goog-api-key')])).toEqual([
      ['GET', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest', 'AIza-test-key-0123']
    ])
  })
})

function findFfmpeg(): string | null {
  for (const bin of [process.env.FFMPEG_PATH, 'ffmpeg']) {
    if (!bin) continue
    if (bin !== 'ffmpeg' && !existsSync(bin)) continue
    if (spawnSync(bin, ['-version']).status === 0) return bin
  }
  return null
}
const FFMPEG = findFfmpeg()

describe.skipIf(!FFMPEG)('judging excerpts cut by ffmpeg', () => {
  it('sends real low-resolution MP4 excerpts, small enough to go inline', async () => {
    const source = join(root, 'take.mp4')
    execFileSync(FFMPEG as string, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1920x1080:rate=30:duration=4',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=330:duration=4',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      '-shortest',
      source
    ])
    const { fetch, sent } = scriptedFetch([
      () =>
        json(
          geminiReply({
            clips: [
              { clip: 1, answer: 'Sharp throughout.', score: 7, problems: [] },
              { clip: 2, answer: 'Sharp throughout.', score: 7, problems: [] }
            ],
            best: null,
            summary: 'Focus holds in both.'
          })
        )
    ])
    const r = await judgeExcerpts(
      {
        clips: [
          { sourcePath: source, startSec: 0, endSec: 1.5 },
          { sourcePath: source, startSec: 2, endSec: 3.5 }
        ],
        question: 'Is focus hunting anywhere here?'
      },
      { gate: gateFor(fetch, { keys: KEY }), ffmpeg: FFMPEG as string, tempDir: mkdtempSync(join(root, 'real-')) }
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.best).toBeNull()
    const parts = JSON.parse(sent[0].text as string).contents[0].parts
    const videos = parts.filter((p: { inlineData?: unknown }) => p.inlineData)
    expect(videos).toHaveLength(2)
    for (const v of videos) {
      const bytes = Buffer.from(v.inlineData.data, 'base64')
      expect(bytes.subarray(4, 8).toString()).toBe('ftyp')
      expect(bytes.length).toBeLessThan(1_000_000)
    }
  })
})
