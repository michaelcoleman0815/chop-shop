/**
 * Several players' recordings of one gaming session, through the app's own
 * steps as the chat runs them when they are dropped in together: cut:session
 * finds the session and lines each recording up with the person's own by the
 * voice chat (main/session-povs), cut:prepare reads theirs as raw footage is
 * read, the others join as its views and pov:listen hears each on its clock,
 * and shared/pov cuts between them. Also: whose microphone is loudest, which
 * the app would take as theirs if they did not say. Writes numbers and the
 * app's sentences, never the words said.
 *
 * A long session need not be read whole to see how it cuts: with --window,
 * the line-up is still found over everything, but only that many seconds of
 * theirs are transcribed and cut, from the middle of the stretch every
 * player recorded. With --keep, the heard edit (its words and every view's
 * sound map) is saved too, so the cut can be read again without hearing the
 * session again; it holds what was said, so it goes where the footage goes.
 *
 *   node scripts/lab.mjs povs <out.json> [--window <seconds>] [--keep <edit.json>] <their file> <another player's file> [...]
 */
import { execFileSync } from 'child_process'
import { chmodSync, rmSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { loudnessEnvelope } from '../../src/main/audio-envelope'
import { registerCutalongIpc } from '../../src/main/cutalong'
import { FFMPEG_PATH, probe } from '../../src/main/ffmpeg'
import type { LinedRecording } from '../../src/shared/pov/lineup'
import type { AudioMap } from '../../src/shared/audio/map'
import { commit, currentCut, resolveCut, type EditDoc, type Source } from '../../src/shared/edit'
import {
  chatPaths,
  joinViews,
  loudestVoice,
  momentsOf,
  ownLevels,
  planPovs,
  povCoverage,
  povLabels,
  povSessionOf,
  povSounds,
  talkerOf,
  type PovAsk
} from '../../src/shared/pov'
import { fail, handler, progressLogger } from './handlers'

async function main(): Promise<void> {
  const [out, ...rest] = process.argv.slice(2)
  let windowSec = 0
  let keep: string | null = null
  while (rest[0] === '--window' || rest[0] === '--keep') {
    const [flag, value] = rest.splice(0, 2)
    if (flag === '--window') windowSec = Number(value)
    else keep = value ?? null
  }
  const files = rest
  if (!out || files.length < 2 || !(windowSec >= 0))
    throw new Error('usage: povs <out.json> [--window <seconds>] [--keep <edit.json>] <their file> <other file> [...]')
  const log = progressLogger()
  const t0 = Date.now()
  const lap = (): number => Math.round((Date.now() - t0) / 100) / 10
  registerCutalongIpc({
    send: (_s, _channel, payload) => log((payload as { stage?: string }).stage ?? ''),
    mediaUrlFor: (p) => `file://${p}`
  })
  const event = { sender: {} }

  // 1. Dropped in together, theirs named as the person would name it.
  const request = `These are our POVs from one session, mine is ${povLabels(files.map((f) => basename(f)))[0]}.`
  const session = (await handler('cut:session')(event, { request, paths: files })) as {
    ok: boolean
    message?: string
    roles?: { talking: string[]; sound: string[]; broll: string[]; reply: string; povs?: (LinedRecording & { camera: Omit<Source, 'id'> })[] }
  }
  if (!session.ok || !session.roles) throw new Error(`cut:session failed: ${session.message}`)
  const roles = session.roles
  const linedAt = lap()

  // Whose microphone is loudest: what the app would take as theirs unsaid.
  const recordings = []
  for (const f of files) recordings.push({ path: f, env: await loudnessEnvelope(FFMPEG_PATH, f, { voice: true }) })
  const loudest = loudestVoice(recordings)

  // 2. Theirs read as raw footage is (only the window, when asked), then the others as its views, each heard on its clock.
  const theirs = roles.talking[0] ?? files[0]
  const homeSec = (await probe(theirs)).durationSec
  let from = 0
  let to = homeSec
  for (const p of roles.povs ?? []) {
    from = Math.max(from, -p.offsetSec)
    to = Math.min(to, p.camera.durationSec - p.offsetSec)
  }
  const window =
    windowSec > 0 && to - from > windowSec
      ? { startSec: Math.round((from + (to - from - windowSec) / 2) * 1000) / 1000, lenSec: windowSec }
      : null
  let read = theirs
  if (window) {
    // Its sound alone, cut exactly at the window (decoded, so the cut is sample-true), as a recording of its own.
    read = join(process.env.LAB_TEMP ?? '/tmp', `povs-window-${process.pid}.wav`)
    execFileSync(FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(window.startSec), '-t', String(window.lenSec), '-i', theirs, '-vn', '-c:a', 'pcm_s16le', read])
  }
  const prepared = (await handler('cut:prepare')(event, { paths: [read], soundPaths: roles.sound, brand: null })) as {
    ok: boolean
    message?: string
    doc?: EditDoc
  }
  if (!prepared.ok || !prepared.doc) throw new Error(`cut:prepare failed: ${prepared.message}`)
  const preparedAt = lap()
  // On the window's clock, each other view sits that much further on.
  const shift = window?.startSec ?? 0
  const joined = joinViews(prepared.doc, (roles.povs ?? []).map((p) => ({ ...p, offsetSec: p.offsetSec + shift })))
  const lined = commit(joined.doc, joined.ops, 'Lined up.').doc
  const listened = (await handler('pov:listen')(event, { doc: lined })) as { ok: boolean; message?: string; maps?: Record<string, AudioMap> }
  if (!listened.ok || !listened.maps) throw new Error(`pov:listen failed: ${listened.message}`)
  const heard: EditDoc = { ...lined, audio: { ...(lined.audio ?? {}), ...listened.maps } }
  const heardAt = lap()
  if (window) rmSync(read, { force: true })
  if (keep) {
    writeFileSync(keep, JSON.stringify(heard), { mode: 0o600 })
    chmodSync(keep, 0o600)
  }

  // 3. Who said what, who reacted, and the cut each mode makes.
  const pov = povSessionOf(heard)
  const sounds = pov ? povSounds(heard, pov) : {}
  const home = pov?.home.id ?? 's1'
  const words = heard.words.filter((w) => w.source === home)
  const own = ownLevels(sounds, words)
  const chat = chatPaths(sounds, words, own)
  const ids = Object.keys(sounds)
  const talkers: Record<string, number> = {}
  for (const w of words) {
    const who = talkerOf(w.id, sounds) ?? 'nobody clearly'
    talkers[who] = (talkers[who] ?? 0) + 1
  }
  const moments = pov ? momentsOf(sounds, words, povCoverage(heard, pov)) : []
  // As it comes in: the views whose line-up is sure (main/session-povs, useCutalong: joinSession); then /povs talking, all of them.
  const sure = heard.sources.filter((s) => (roles.povs ?? []).some((p) => p.path === s.path && p.sure)).map((s) => s.id)
  const asks: [string, PovAsk][] = [
    ['as it comes in: reactions, everyone, the play in, the sure views', { mode: 'reactions', everyone: true, fill: true, only: sure }],
    ['talking, everyone, the play in', { mode: 'talking', everyone: true, fill: true }]
  ]
  const cuts = asks.map(([name, ask]) => {
    const plan = planPovs(heard, ask)
    if (!('ops' in plan)) return { name, said: plan.say }
    const done = commit(heard, plan.ops, plan.summary)
    const cut = currentCut(done.doc)
    const resolved = resolveCut(cut, done.doc.words, done.doc.sources)
    // Shots: runs of one view, as played.
    const shots: { view: string; sec: number }[] = []
    for (const p of resolved.pieces) {
      const b = cut.beats.find((x) => x.id === p.beat)
      const view = b?.treatment.grid ? 'grid' : b?.treatment.angle?.layout === 'full' ? b.treatment.angle.source : home
      const last = shots[shots.length - 1]
      if (last && last.view === view) last.sec += p.outEnd - p.outStart
      else shots.push({ view, sec: p.outEnd - p.outStart })
    }
    const share: Record<string, number> = {}
    for (const s of shots) share[s.view] = (share[s.view] ?? 0) + s.sec
    const lengths = shots.map((s) => s.sec).sort((a, b) => a - b)
    return {
      name,
      summary: plan.summary,
      rejected: done.rejected.length,
      away: plan.away,
      grids: plan.grids,
      runsSec: Math.round(resolved.durationSec),
      shots: shots.length,
      shortestShotSec: Math.round((lengths[0] ?? 0) * 100) / 100,
      medianShotSec: Math.round((lengths[Math.floor(lengths.length / 2)] ?? 0) * 100) / 100,
      secondsByView: Object.fromEntries(Object.entries(share).map(([k, v]) => [k, Math.round(v)]))
    }
  })

  writeFileSync(
    out,
    JSON.stringify(
      {
        files,
        reply: roles.reply,
        roles: { talking: roles.talking, sound: roles.sound, broll: roles.broll },
        lined: (roles.povs ?? []).map(({ camera: _c, ...l }) => l),
        loudestVoice: loudest,
        loudestIsTheirs: loudest === files[0],
        // The stretch every player recorded, on theirs, and the window read from it.
        shared: { fromSec: Math.round(from), toSec: Math.round(to) },
        window,
        warning: (prepared as { warning?: string | null }).warning ?? null,
        words: words.length,
        views: pov ? [pov.home, ...pov.others] : [],
        ownVoiceDb: own,
        chatDb: Object.fromEntries(ids.flatMap((a) => ids.filter((b) => b !== a).map((b) => [`${a}>${b}`, Math.round(chat(a, b) * 10) / 10]))),
        talkers,
        moments: moments.map((m) => ({ view: m.view, kind: m.kind, startSec: Math.round(m.startSec * 10) / 10, strength: Math.round(m.strength * 10) / 10 })),
        cuts,
        seconds: { lined: linedAt, prepared: preparedAt, heard: heardAt, all: lap() }
      },
      null,
      1
    )
  )
  process.stderr.write(`lined ${roles.povs?.length ?? 0} of ${files.length - 1}, ${words.length} words, ${moments.length} reactions in ${lap()} s\n`)
}

main().catch(fail)
