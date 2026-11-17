import { useCallback, useRef, type MutableRefObject } from 'react'
import { addAsset as addAssetTo, gridOps, resolveCut, currentCut, type EditDoc, type Op } from '../../../shared/edit'
import { isImagePath, searchIcons } from '../../../shared/assets'
import { cardLine, graphicAsked, listNear, titleToSlug } from '../../../shared/motion'
import type { Preset } from '../../../shared/presets'
import { api } from './api'
import type { Attachment } from './components/Composer'
import type { Msg } from './components/Message'
import { isVideoFile } from './format'
import { loadLogoMarks } from './graphics'
import type { PanelStatus } from './useCutalong'

/**
 * The talking-head graphics and the grid, as the session runs them: /grid
 * (an edit of several videos at once from files dropped in, or a grid on the
 * beat under the playhead), /videos from links (each read for its title,
 * views and thumbnail, never downloaded), icons for chips that are not
 * brands, and these graphics asked for in plain words, read here before any
 * planner. useCutalong calls in from submit, commandNow and the editor's notes.
 */

type Where = 'thread' | 'panel'

export const SHOWCASE_ENTRIES: Preset[] = [
  {
    command: 'grid',
    title: 'Grid',
    summary: 'Two to four videos at once, each with a label: drop them in with /grid, or /grid Talk, Map, Doc, Phone',
    builtIn: true,
    style: {},
    inspiration: null
  }
]

export interface ShowcaseDeps {
  docRef: MutableRefObject<EditDoc | null>
  setDoc: (next: EditDoc) => void
  setMediaUrl: (url: string | null) => void
  push: (m: Omit<Msg, 'id'>) => string
  patch: (id: string, m: Partial<Msg>) => void
  setPanel: (p: PanelStatus | null) => void
  applyAsVersion: (ops: Op[], fallback: string) => { summary: string; n: number } | null
  /** A graphics command placed on the word under the playhead. */
  placeGraphic: (command: string, where: Where, rest: string, at: number | null, aside?: string) => void
  /** Any slash command, as typed. */
  run: (command: string, where: Where, rest: string, at: number | null) => Promise<void>
  /** The names of the creator's own logos, which chips show as they are. */
  logoNames: () => string[]
}

export interface Showcase {
  /** Handles /grid, /videos with links and /chips; false for anything else. */
  command(command: string, where: Where, rest: string, at: number | null, beat: string | null): Promise<boolean>
  /** Files dropped in with /grid or "put these in a grid": an edit of them at once. False when not asked. */
  files(recordings: Attachment[], command: string | null, said: string): Promise<boolean>
  /** Whether files dropped in are asked to play as a grid, before anything else claims them (a label "Vlog" is not a vlog). */
  asksGrid(files: Attachment[], command: string | null, said: string): boolean
  /** A graphic asked for in plain words, links and all, run as its command. False when the words ask for something else. */
  words(text: string, where: Where, at: number | null): Promise<boolean>
  /** Whether plain words ask for one of these graphics, and an edit is open to put it on. */
  claims(text: string): boolean
  /** Whether a command reads its own links (/videos), so the chat neither studies them nor brings them in. */
  ownsLinks(command: string | null): boolean
}

const LINKS = /https?:\/\/[^\s<>"']+/gi

/** Lucide's tags, loaded the first time a chip needs an icon. */
let tags: Promise<Record<string, string[]>> | null = null
function lucideTags(): Promise<Record<string, string[]>> {
  tags ??= import('lucide-static/tags.json').then((m) => (m.default ?? m) as unknown as Record<string, string[]>)
  return tags
}

export function useShowcase(deps: ShowcaseDeps): Showcase {
  const live = useRef(deps)
  live.current = deps

  const say = useCallback((where: Where, text: string, open = false, extra: Partial<Msg> = {}): void => {
    const { push, setPanel } = live.current
    if (where === 'panel') setPanel({ text })
    else
      push({
        role: 'assistant',
        text,
        ...extra,
        actions: open ? [{ kind: 'open-editor', label: 'Open the editor', primary: true }] : undefined
      })
  }, [])

  /**
   * Each chip's word with its icon: a brand (the creator's own, or one Simple
   * Icons has) shows its logo; anything else gets the Lucide icon nearest its
   * name. Names given with an icon already keep it.
   */
  const withIcons = useCallback(async (names: string[]): Promise<string> => {
    const [logos, lucide] = await Promise.all([loadLogoMarks(), lucideTags()])
    const own = new Set(live.current.logoNames().map((n) => n.trim().toLowerCase()))
    return names
      .map((raw) => {
        if (raw.includes(':')) return raw
        const name = raw.trim()
        if (own.has(name.toLowerCase()) || logos(titleToSlug(name))) return name
        const icon = searchIcons(name, lucide, 1)[0]
        return icon ? `${name}: ${icon}` : name
      })
      .join(', ')
  }, [])

  const command = useCallback(
    async (command: string, where: Where, rest: string, at: number | null, beat: string | null): Promise<boolean> => {
      const { docRef, applyAsVersion, placeGraphic, setDoc, push, patch } = live.current
      if (command === 'grid') {
        const d = docRef.current
        if (!d) {
          say(where, 'Drop two to four videos with /grid, your exported edits or any footage, and I will play them at once in a grid.')
          return true
        }
        const plan = gridOps(d, beat, rest)
        if ('problem' in plan) {
          say(where, plan.problem)
          return true
        }
        const done = applyAsVersion(plan.ops, plan.summary)
        say(where, done ? `v${done.n} is ready. ${done.summary}` : 'That is already how the grid is.', !!done)
        return true
      }
      if (command === 'videos') {
        const links = [...new Set(rest.match(LINKS) ?? [])].slice(0, 4)
        if (links.length === 0) return false
        const d = docRef.current
        if (!d) {
          say(where, 'Drop some footage first, then the videos’ cards can go on it.')
          return true
        }
        // Scout's job (crew.ts): fetching pages, as a captured page is.
        const stage = { stage: 'Fetching the videos’ pages', percent: null }
        const id = where === 'thread' ? push({ role: 'assistant', text: '', progress: stage }) : null
        if (where === 'panel') live.current.setPanel({ text: '', progress: stage })
        const lines: string[] = []
        const failed: string[] = []
        let doc = docRef.current ?? d
        for (const url of links) {
          const r = await api.videoCard({ docId: d.id, url })
          if (!r.ok) {
            failed.push(r.message)
            continue
          }
          let thumb = ''
          if (r.asset) {
            const added = addAssetTo(doc, r.asset)
            doc = added.doc
            thumb = added.asset.id
          }
          const line = cardLine(r.card.views, r.card.uploaded ? new Date(r.card.uploaded) : null, new Date())
          lines.push([thumb, r.card.title.replace(/[|\n;]+/g, ' '), line].join(' | '))
        }
        if (doc !== docRef.current) setDoc(doc)
        const note = failed.length ? `I couldn't read ${failed.length === 1 ? 'one link' : `${failed.length} links`}: ${failed[0]}` : undefined
        if (id) patch(id, { progress: null, text: lines.length ? `I read ${lines.length === 1 ? 'the video' : `${lines.length} videos`} without downloading ${lines.length === 1 ? 'it' : 'them'}.` : (note ?? 'There was nothing to read.'), error: lines.length === 0 })
        if (lines.length === 0) {
          if (where === 'panel') live.current.setPanel({ text: note ?? 'There was nothing to read.', error: true })
          return true
        }
        const words = rest.replace(LINKS, ' ').replace(/[,;]+/g, ' ').trim()
        placeGraphic('videos', where, [words, lines.join('\n')].filter(Boolean).join(' '), at, note)
        return true
      }
      if (command === 'chips') {
        const d = docRef.current
        if (!d) return false
        const style = /^(light|dark|accent)\b/i.exec(rest.trim())?.[1] ?? ''
        const given = rest
          .trim()
          .replace(/^(light|dark|accent)\b/i, '')
          .split(/\s*[,;|]\s*/)
          .map((s) => s.trim())
          .filter(Boolean)
        // Named nowhere: the list said nearest the playhead, named here so each finds its word.
        const names = given.length ? given : (listNear(resolveCut(currentCut(d), d.words, d.sources), at)?.names ?? [])
        if (names.length === 0) return false
        placeGraphic('chips', where, `${style} ${await withIcons(names.slice(0, 12))}`.trim(), at)
        return true
      }
      return false
    },
    [say, withIcons]
  )

  const asksGrid = useCallback(
    (files: Attachment[], command: string | null, said: string): boolean =>
      (command === 'grid' || graphicAsked(said)?.command === 'grid') &&
      files.filter((f) => isVideoFile(f.name) || isImagePath(f.name)).length >= 2,
    []
  )

  const files = useCallback(async (recordings: Attachment[], command: string | null, said: string): Promise<boolean> => {
    const pictures = recordings.filter((f) => isVideoFile(f.name) || isImagePath(f.name))
    if (!asksGrid(recordings, command, said)) return false
    const { docRef, push, patch, setDoc, setMediaUrl, applyAsVersion } = live.current
    const labels = (command === 'grid' ? said : (graphicAsked(said)?.rest ?? '')).trim()
    // Asked for none, every panel's label is empty; given none, each is named after its file.
    const none = /^(?:no|without) labels?$/i.test(labels)
    const given = none ? pictures.map(() => '') : labels ? labels.split(/\s*[,;|]\s*/).filter(Boolean) : undefined
    if (pictures.length > 4) say('thread', `A grid holds four at most, so I used the first four of ${pictures.length}.`)
    const d = docRef.current
    if (!d) {
      // Scout's job (crew.ts): the files are read and brought into a new edit.
      const id = push({ role: 'assistant', text: '', progress: { stage: 'Bringing the videos in', percent: null } })
      const r = await api.makeGrid({ paths: pictures.slice(0, 4).map((f) => f.path), labels: given })
      if (!r.ok) {
        patch(id, { progress: null, text: r.message, error: true })
        return true
      }
      setDoc(r.doc)
      setMediaUrl(r.mediaUrl)
      const version = r.doc.versions[r.doc.versions.length - 1]
      patch(id, {
        progress: null,
        text: `v${version.n} is ready. ${version.summary} The sound is the first video’s; /grid sound 2 takes another’s, /grid music leaves only music.`,
        actions: [{ kind: 'open-editor', label: 'Open the editor', primary: true }]
      })
      return true
    }
    // An edit already open: the files come in as material and the beat under the playhead plays them at once.
    let doc = d
    for (const f of pictures.slice(0, 3)) {
      const r = await api.addAsset({ docId: d.id, path: f.path })
      if (r.ok) doc = addAssetTo(doc, r.asset).doc
    }
    setDoc(doc)
    const plan = gridOps(doc, null, none ? 'no labels' : given ? given.join(', ') : '')
    if ('problem' in plan) {
      say('thread', plan.problem)
      return true
    }
    const done = applyAsVersion(plan.ops, plan.summary)
    say('thread', done ? `v${done.n} is ready. ${done.summary}` : 'That is already how the grid is.', !!done)
    return true
  }, [say, asksGrid])

  /** What plain words ask for, read without their links, and the links that go with it. */
  const read = useCallback((text: string): { command: string; rest: string } | null => {
    const links = [...new Set(text.match(LINKS) ?? [])]
    const ask = graphicAsked(text.replace(LINKS, ' ').replace(/\s+/g, ' ').trim())
    if (!ask || ask.command === 'grid') return null
    // Cards need the videos' links; a page to ring is captured from its link, or is the newest one in the edit.
    if (ask.command === 'videos') return links.length ? { command: 'videos', rest: links.join(' ') } : null
    if (ask.command === 'screenshot') return { command: 'screenshot', rest: [ask.rest, links[0] ?? ''].join(' ').trim() }
    return ask
  }, [])

  const claims = useCallback((text: string): boolean => !!live.current.docRef.current && read(text) !== null, [read])

  const words = useCallback(
    async (text: string, where: Where, at: number | null): Promise<boolean> => {
      const ask = read(text)
      if (!ask || !live.current.docRef.current) return false
      await live.current.run(ask.command, where, ask.rest, at)
      return true
    },
    [read]
  )

  const ownsLinks = useCallback((command: string | null): boolean => command === 'videos', [])

  return { command, files, asksGrid, words, claims, ownsLinks }
}
