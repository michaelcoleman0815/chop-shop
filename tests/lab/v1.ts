/**
 * Cutalong's first cut of a prepared doc, by the app's own planners, as the
 * chat runs them with a brand's niche:
 *
 *   takes        "Keep the best takes" (/takes)
 *   tighten      /tighten: the best takes, then the profile's pauses and fillers
 *   snappy       /snappy
 *   length:SEC   "make it SEC seconds" (shared/raw/length)
 *   under:SEC    "make it under SEC seconds"
 *
 * For each policy it writes the doc with that version committed, and a
 * report: the beats that play (output and source times, words) and every run
 * of words cut, with the reason (which take, false start, set-up talk,
 * filler, or a line cut for length).
 *
 *   node scripts/lab.mjs v1 <prepared.json> <out-prefix> <niche> <policy> [<policy> ...]
 */
import { readFileSync, writeFileSync } from 'fs'
import { commit, currentCut, resolveCut, type EditDoc, type Op } from '../../src/shared/edit'
import {
  DEFAULT_PROFILE,
  planLength,
  profileById,
  styleForProfile,
  suggestProfile,
  takesOf,
  type CuttingProfile,
  type LengthAsk
} from '../../src/shared/raw'
import { BUILT_IN_PRESETS } from '../../src/shared/presets/preset'
import { planStyle } from '../../src/shared/presets/plan'
import { isFiller } from '../../src/shared/fillers'
import { fail } from './handlers'

/** As the chat picks it (renderer useCutalong profileFor): the edit's own, the brand's niche, the words, a talking head. */
export function profileFor(doc: EditDoc, niche: string): CuttingProfile {
  return profileById(doc.profile) ?? profileById(niche) ?? suggestProfile(doc.words)?.profile ?? DEFAULT_PROFILE
}

const r2 = (x: number): number => Math.round(x * 100) / 100

interface Planned {
  ops: Op[]
  summary: string
  extra: Record<string, unknown>
}

export function planPolicy(doc: EditDoc, policy: string, profile: CuttingProfile): Planned {
  if (policy === 'takes' || policy === 'tighten' || policy === 'snappy') {
    const preset = BUILT_IN_PRESETS.find((p) => p.command === policy)
    if (!preset) throw new Error(`no preset ${policy}`)
    const plan = planStyle(doc, styleForProfile(policy, preset.style, profile), currentCut(doc), {
      thresholds: profile.takes ?? undefined
    })
    return {
      ops: plan.ops,
      summary: [plan.takes?.summary, `${preset.title} is on.`].filter(Boolean).join(' '),
      extra: { open: plan.open, offered: plan.takes?.offerText ?? '', counts: plan.takes?.counts ?? null }
    }
  }
  const m = /^(length|under):(\d+(?:\.\d+)?)$/.exec(policy)
  if (!m) throw new Error(`unknown policy ${policy}`)
  const sec = Number(m[2])
  const ask: LengthAsk =
    m[1] === 'under' ? { range: [Math.max(1, sec * 0.9), sec], under: true, cut: [] } : { targetSec: sec, cut: [] }
  const plan = planLength(doc, ask, { profile })
  return { ops: plan.ops, summary: plan.summary, extra: { note: plan.note, met: plan.met } }
}

/** Why each word that no longer plays left the cut: the takes analysis, the ops, the fillers. */
function reasons(doc: EditDoc, ops: Op[]): Map<string, string> {
  const why = new Map<string, string>()
  const pos = new Map(doc.words.map((w, i) => [w.id, i]))
  const mark = (from: string, to: string, text: string): void => {
    const a = pos.get(from)
    const b = pos.get(to)
    if (a === undefined || b === undefined) return
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (!why.has(doc.words[i].id)) why.set(doc.words[i].id, text)
  }
  for (const an of takesOf(doc)) {
    for (const g of an.groups) {
      g.takes.forEach((t, i) => {
        if (i === g.chosen) return
        const how = [t.complete ? 'complete' : 'broken off', ...t.issues].join(', ')
        mark(
          t.span.from,
          t.span.to,
          `retake: take ${i + 1} of ${g.takes.length} of “${g.label}” (${how}); kept take ${g.chosen + 1}, ${g.reason}; sure ${g.confidence.toFixed(2)}`
        )
      })
    }
    for (const r of an.restarts)
      mark(r.from, r.to, `${r.kind === 'stutter' ? 'stutter' : 'false start'} before “${r.repeated}”; sure ${r.confidence.toFixed(2)}`)
    for (const s of an.setup) mark(s.from, s.to, `set-up talk at the ${s.where}; sure ${s.confidence.toFixed(2)}`)
    for (const c of an.cues) mark(c.from, c.to, 'a spoken retake cue')
  }
  const beats = currentCut(doc).beats
  for (const op of ops) {
    if (op.op !== 'remove') continue
    for (const id of op.beats) {
      const b = beats.find((x) => x.id === id)
      if (b?.from && b?.to) mark(b.from, b.to, op.why === 'length' ? 'cut for length: among the weakest lines' : `cut: ${op.why ?? 'removed'}`)
    }
  }
  return why
}

export function report(doc: EditDoc, made: EditDoc, ops: Op[]) {
  const cut = currentCut(made)
  const resolved = resolveCut(cut, made.words, made.sources)
  const playing = new Set(resolved.words.map((w) => w.id))
  const byId = new Map(made.words.map((w) => [w.id, w]))
  const why = reasons(doc, ops)
  const beats = resolved.beats.map((rb) => {
    const pieces = resolved.pieces.filter((p) => p.beat === rb.id)
    return {
      beat: rb.id,
      out: [r2(rb.outStart), r2(rb.outEnd)],
      src: pieces.length ? [pieces[0].source, r2(pieces[0].srcStart), r2(pieces[pieces.length - 1].srcEnd)] : null,
      text: rb.words.map((id) => byId.get(id)?.text ?? '').join(' ')
    }
  })
  const cuts: { src: [string, number, number]; words: number; text: string; why: string }[] = []
  let run: EditDoc['words'] = []
  let runWhy = ''
  const flush = (): void => {
    if (run.length === 0) return
    const text = run.map((w) => w.text).join(' ')
    cuts.push({
      src: [run[0].source, r2(run[0].startSec), r2(run[run.length - 1].endSec)],
      words: run.length,
      text: text.length > 240 ? `${text.slice(0, 240)}…` : text,
      why: runWhy
    })
    run = []
  }
  for (const w of made.words) {
    if (playing.has(w.id)) {
      flush()
      continue
    }
    const reason = why.get(w.id) ?? (cut.tighten && isFiller(w.text) ? 'a filler, cut by tightening' : 'outside every beat')
    if (run.length && (reason !== runWhy || run[run.length - 1].source !== w.source)) flush()
    runWhy = reason
    run.push(w)
  }
  flush()
  return { durationSec: r2(resolved.durationSec), words: resolved.words.length, beats, cuts }
}

function main(): void {
  const [input, prefix, niche, ...policies] = process.argv.slice(2)
  if (!input || !prefix || policies.length === 0) throw new Error('usage: v1 <prepared.json> <out-prefix> <niche> <policy> ...')
  const doc = (JSON.parse(readFileSync(input, 'utf8')) as { prepared: { doc: EditDoc } }).prepared.doc
  const profile = profileFor(doc, niche === '-' ? '' : niche)
  const raw = resolveCut(currentCut(doc), doc.words, doc.sources)
  // What the takes analysis found, and each policy's cut under its own name (one is called "takes").
  const policiesDone: Record<string, unknown> = {}
  const summary = {
    profile: profile.id,
    rawSec: r2(doc.sources.reduce((s, x) => s + x.durationSec, 0)),
    rawPlaysSec: r2(raw.durationSec),
    rawWords: doc.words.length,
    policies: policiesDone,
    found: takesOf(doc).map((a) => ({
      source: a.source,
      groups: a.groups.map((g) => ({
        label: g.label,
        chosen: g.chosen,
        reason: g.reason,
        confidence: r2(g.confidence),
        takes: g.takes.map((t) => ({ start: r2(t.startSec), end: r2(t.endSec), complete: t.complete, fluency: r2(t.fluency), issues: t.issues }))
      })),
      restarts: a.restarts.map((r) => ({ kind: r.kind, at: r2(r.atSec), repeated: r.repeated, confidence: r2(r.confidence) })),
      setup: a.setup.map((s) => ({ where: s.where, start: r2(s.startSec), end: r2(s.endSec), confidence: r2(s.confidence) }))
    }))
  }
  for (const policy of policies) {
    const p = planPolicy(doc, policy, profile)
    const made = commit(doc, p.ops, p.summary || policy).doc
    const rep = report(doc, made, p.ops)
    const name = policy.replace(/[^\w.-]+/g, '_')
    writeFileSync(`${prefix}.${name}.doc.json`, JSON.stringify(made))
    writeFileSync(`${prefix}.${name}.report.json`, JSON.stringify({ policy, summary: p.summary, ...p.extra, ...rep }, null, 1))
    policiesDone[policy] = { summary: p.summary, durationSec: rep.durationSec, words: rep.words, beats: rep.beats.length, ...p.extra }
    process.stderr.write(`${policy}: ${rep.durationSec} s, ${rep.words} words, ${rep.beats.length} beats. ${p.summary}\n`)
  }
  writeFileSync(`${prefix}.summary.json`, JSON.stringify(summary, null, 1))
}

try {
  main()
} catch (err) {
  fail(err)
}
