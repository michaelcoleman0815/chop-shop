import { expect } from 'vitest'
import { applyOps, createDoc, currentCut, wordsFromTranscript, type Cut, type EditDoc, type Op } from '../shared/edit'
import { tracksOf, type TrackClip } from '../shared/tracks'

/**
 * The asks the live layers test puts to Claude, and what a right answer leaves
 * on the edit. Shared by the live test (layers-plan.live.test.ts), which asks
 * Claude, and the recorded one (layers-plan.recorded.test.ts), which replays
 * plans Claude once made, so a change to the ops that would break them shows
 * in every run without spending credit.
 *
 * A check accepts any fair way to do what was asked: a title rising in can be
 * the graphics' own title or a keyed text clip, B-roll over a sentence can sit
 * on the beat or on a layer track.
 */

const said = 'Today I want to show you the new laptop I have been using and honestly it is fast and the battery lasts all day'
export const words = wordsFromTranscript(
  said.split(' ').map((text, i) => ({ text, startSec: 0.4 + i * 0.42, endSec: 0.72 + i * 0.42 })),
  's1'
)
const source = { id: 's1', path: '/footage/take.mov', durationSec: 11, width: 1920, height: 1080, fps: 30 }
const origin = { type: 'file' as const, url: null, author: null, license: null, range: null }
const BROLL = '/footage/laptop-broll.mp4'

export function talk(): EditDoc {
  const doc = createDoc({ id: 'live-layers', title: 'Laptop', source, words })
  return {
    ...doc,
    assets: [
      { id: 'a1', kind: 'video', path: BROLL, title: 'Laptop on a desk, keys typing', durationSec: 8, width: 1920, height: 1080, origin },
      { id: 'a2', kind: 'image', path: '/footage/logo.png', title: 'The laptop maker’s logo', durationSec: null, width: 800, height: 800, origin }
    ]
  }
}

export const id = (text: string): string => words.find((w) => w.text === text)?.id ?? ''

export type PlacedClip = TrackClip & { trackKind: string }

export interface Applied {
  cut: Cut
  clips: PlacedClip[]
  rejected: string[]
}

/** A plan's ops applied to the edit it was asked of, as the app applies a plan. */
export function applyPlan(doc: EditDoc, ops: Op[]): Applied {
  const applied = applyOps(currentCut(doc), ops, { words: doc.words, sources: doc.sources, assets: doc.assets })
  return {
    cut: applied.cut,
    clips: tracksOf(applied.cut).flatMap((t) => t.clips.map((c) => ({ ...c, trackKind: t.kind }))),
    rejected: applied.rejected.map((x) => x.reason)
  }
}

/** The beats that play a stretch of words, by their ids in order. */
function beatsOver(cut: Cut, from: string, to: string) {
  const index = (w: string | null) => words.findIndex((x) => x.id === w)
  const [a, b] = [index(from), index(to)]
  return cut.beats.filter((beat) => index(beat.from) <= b && index(beat.to) >= a)
}

export interface LayerAsk {
  name: string
  request: string
  check: (r: Applied) => void
}

export const LAYER_ASKS: LayerAsk[] = [
  {
    name: 'puts the B-roll in a box over the speaker, from a word to a word, fading in',
    request: 'Put the laptop B-roll in a small box in the top right corner from "new" to "fast", fading in.',
    check: ({ clips }) => {
      const box = clips.find((c) => c.kind === 'video' && c.src === 'a1')
      expect(box, 'a video clip of a1').toBeTruthy()
      expect(box?.from).toMatch(new RegExp(`^${id('new')}`))
      // Small and to the right: a scale under one and a position right of the middle, held or keyed.
      expect(JSON.stringify(box?.transform ?? {})).toMatch(/scale/)
      expect(JSON.stringify(box?.opacity ?? '')).toMatch(/keys/)
    }
  },
  {
    name: 'flies a big title in from below over the last words',
    request: 'Add a big yellow title that says ALL DAY over the last two words, flying in from below.',
    check: ({ cut, clips }) => {
      // Either the graphics' own title rising in, or a text clip with its height keyed.
      const graphic = cut.motion.find((m) => m.kind === 'title' && m.text.join(' ').toUpperCase().includes('ALL DAY'))
      const text = clips.find((c) => c.kind === 'text' && (c.text?.value ?? '').toUpperCase().includes('ALL DAY'))
      expect(graphic ?? text, 'an ALL DAY title').toBeTruthy()
      if (graphic) {
        expect(graphic.style, 'a title style that comes in from below').toBe('rise')
        expect(graphic.from).toMatch(new RegExp(`^${id('all')}`))
      } else {
        expect(JSON.stringify(text?.transform ?? {})).toMatch(/"y":\{"keys"/)
      }
    }
  },
  {
    name: 'trims the edit’s first beat by hand to start on a word',
    request: 'Trim the start so the video begins on the word "show".',
    check: ({ cut }) => {
      expect(cut.beats[0].from === id('show') || cut.removed.includes(id('Today'))).toBe(true)
    }
  },
  {
    name: 'darkens the picture with a solid layer, and keeps the B-roll silent',
    request:
      'Lay a black layer at 40% over the whole video so text stands out, then put the laptop B-roll over the first sentence with its sound off.',
    check: ({ cut, clips }) => {
      expect(clips.some((c) => c.kind === 'solid' && /^#0{6}$/i.test(c.color ?? ''))).toBe(true)
      // The B-roll either on a layer track, muted, or on the first sentence's beats, muted.
      const layer = clips.find((c) => c.kind === 'video' && c.src === 'a1')
      if (layer) {
        expect(layer.muted).toBe(true)
        return
      }
      const over = beatsOver(cut, id('Today'), id('using'))
      expect(over.length, 'beats over the first sentence').toBeGreaterThan(0)
      for (const beat of over) {
        expect(beat.treatment.frame).toBe('broll')
        expect(beat.treatment.broll?.path).toBe(BROLL)
        expect(beat.treatment.broll?.muted).toBe(true)
      }
      // Only the first sentence: the beat after it is the speaker again.
      expect(beatsOver(cut, id('and'), id('day')).every((b) => b.treatment.frame !== 'broll')).toBe(true)
    }
  }
]
