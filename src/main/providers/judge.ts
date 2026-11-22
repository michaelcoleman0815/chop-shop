import { mkdtemp, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { askGemini, GEMINI_MAX_CLIPS, GEMINI_MAX_INLINE_BYTES } from './gemini'
import { ServiceError, type FailureKind, type Gate } from './gate'
import { cutExcerpt, type Excerpt } from './media'

/**
 * Judging delivery from the sound and the picture: which take is best and
 * why, or whether a stretch has a visible problem such as focus hunting.
 *
 * The raw-footage builder's take chooser calls this at merge for the
 * decisions it is least sure of. It cuts a short, low-resolution excerpt of
 * each stretch on this computer and sends only those, never the recording.
 */

export interface ExcerptClip {
  sourcePath: string
  startSec: number
  endSec: number
}

export interface JudgeInput {
  clips: ExcerptClip[]
  /** For example "Which take is delivered best, and why?" or "Is focus hunting anywhere here?" */
  question: string
}

export interface ClipJudgement extends ExcerptClip {
  /** One or two sentences answering the question for this clip. */
  answer: string
  /** 0 to 10 for how well this clip does on what was asked; 10 is best. */
  score: number
  /** Problems seen or heard, each a short phrase with a time inside the clip, such as "focus hunts at 0:04". */
  problems: string[]
  /** The clip judged best, when the question asked for one. */
  best: boolean
}

export type JudgeResult =
  | {
      ok: true
      service: 'gemini'
      /** One sentence answering the question across the clips. */
      summary: string
      /** Index into clips of the best one, or null when the question was not a choice. */
      best: number | null
      /** In the order they were given. */
      clips: ClipJudgement[]
    }
  | {
      ok: false
      /** invalid: the request itself could not be judged. The rest are the gate's reasons. */
      reason: FailureKind | 'invalid'
      message: string
    }

/** The longest stretch judged at once. Long enough for a take, short enough to stay small. */
export const JUDGE_MAX_CLIP_SEC = 60

export interface JudgeDeps {
  gate: Gate
  ffmpeg: string
  /** Where excerpts are cut, a folder of their own that is removed afterwards. */
  tempDir: string
  /** Cuts one excerpt; injectable for tests. */
  cut?: (ffmpeg: string, clip: ExcerptClip, out: string) => Promise<Excerpt>
}

export function judgeProblem(input: JudgeInput): string | null {
  if (typeof input?.question !== 'string' || !input.question.trim()) return 'Ask a question about the clips.'
  if (input.question.length > 2000) return 'Keep the question under 2,000 characters.'
  const clips = Array.isArray(input.clips) ? input.clips : []
  if (clips.length < 1 || clips.length > GEMINI_MAX_CLIPS) {
    return `Give me between 1 and ${GEMINI_MAX_CLIPS} clips to judge.`
  }
  for (const [i, c] of clips.entries()) {
    if (typeof c?.sourcePath !== 'string' || !c.sourcePath) return `Clip ${i + 1} has no recording.`
    if (!Number.isFinite(c.startSec) || !Number.isFinite(c.endSec) || c.startSec < 0 || c.endSec <= c.startSec) {
      return `Clip ${i + 1} needs an end after its start.`
    }
    if (c.endSec - c.startSec > JUDGE_MAX_CLIP_SEC) {
      return `Clip ${i + 1} runs ${Math.round(c.endSec - c.startSec)} s, and I judge stretches of up to ${JUDGE_MAX_CLIP_SEC} s.`
    }
  }
  return null
}

export async function judgeExcerpts(input: JudgeInput, deps: JudgeDeps): Promise<JudgeResult> {
  const problem = judgeProblem(input)
  if (problem) return { ok: false, reason: 'invalid', message: problem }

  // Asked before anything is cut, so nothing is made for a request that cannot go.
  const refused = deps.gate.refusal('gemini')
  if (refused) return { ok: false, reason: refused.kind, message: refused.message }

  const cut = deps.cut ?? cutExcerpt
  const dir = await mkdtemp(join(deps.tempDir, 'cutalong-judge-'))
  try {
    const excerpts: Excerpt[] = []
    for (const [i, clip] of input.clips.entries()) {
      try {
        excerpts.push(await cut(deps.ffmpeg, clip, join(dir, `clip-${i + 1}.mp4`)))
      } catch (err) {
        return {
          ok: false,
          reason: 'failed',
          message: `I could not cut clip ${i + 1}: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    }
    const total = excerpts.reduce((sum, e) => sum + e.bytes, 0)
    if (total > GEMINI_MAX_INLINE_BYTES) {
      return {
        ok: false,
        reason: 'too-big',
        message: `The excerpts come to ${(total / 1e6).toFixed(1)} MB, more than the ${GEMINI_MAX_INLINE_BYTES / 1e6} MB I send to Google Gemini at once.`
      }
    }
    const inline = await Promise.all(
      excerpts.map(async (e) => ({ data: await readFile(e.path), durationSec: e.durationSec }))
    )
    const verdict = await askGemini(deps.gate, input.question, inline)
    const best = verdict.best === null ? null : verdict.best - 1
    return {
      ok: true,
      service: 'gemini',
      summary: verdict.summary,
      best,
      clips: input.clips.map((clip, i) => ({
        sourcePath: clip.sourcePath,
        startSec: clip.startSec,
        endSec: clip.endSec,
        answer: verdict.clips[i].answer,
        score: verdict.clips[i].score,
        problems: verdict.clips[i].problems,
        best: best === i
      }))
    }
  } catch (err) {
    if (err instanceof ServiceError) return { ok: false, reason: err.kind, message: err.message }
    return { ok: false, reason: 'failed', message: err instanceof Error ? err.message : String(err) }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
