import type { Carry } from './assemble'
import type { KeyService } from './key-steps'
import type { Quote, QuoteLine } from './quote'
import type { Bible, Brief, ImageService, MadeShot, Sheet, VoiceChoice } from './schema'
import type { Word } from '../edit/schema'

/**
 * What a made video is while it is quoted and confirmed, and what an ask of
 * a made video costs, as the main process hands them to the window and the
 * window hands them back (main/make). Types only: the decisions are in
 * main/make/run.ts and remake.ts.
 */

export interface Draft {
  id: string
  brief: Brief
  title: string
  outline: string[]
  script: string
  phrases: string[]
  sections: number[]
  /** What writing the script cost already, on the Anthropic key. */
  scriptCost: number
  quote: Quote
  /** Made again from a made video: what stays as it is. */
  kept?: Kept
  /** Made again into this edit: its id, and the recording id a new narration takes in it. */
  into?: { docId: string; sourceId: string; summary: string; carry: Carry }
}

/** What a remake keeps of the video it is made from, so it is neither paid for nor sent again. */
export interface Kept {
  narration?: {
    path: string
    durationSec: number
    sourceId: string
    /** The narration's words as the edit has them. */
    words: Word[]
    voice: VoiceChoice
    timing: 'voice' | 'whisper'
  }
  shots?: { bible: Bible; shots: MadeShot[]; sheets: Sheet[] }
}

export interface Reply {
  text: string
  aside: string | null
  chips: string[]
  details: { label: string; value: string }[]
}

/** One shot made again, quoted. */
export interface ShotChange {
  kind: 'shot'
  phrase: number
  beat: string
  /** What the person wants it to show; empty for a new take of the same picture. */
  want: string
  /** A new take, so not the one in the cache. */
  take: number
  images: ImageService
  clips: ImageService | null
  lines: QuoteLine[]
  total: number
  auto: boolean
  missing: string[]
  keys: KeyService[]
  sends: string[]
  reply: Reply
}

export type Change =
  | ShotChange
  /** A new narration, style or length: a draft of the whole video, quoted like the first. */
  | { kind: 'draft'; draft: Draft; reply: Reply }
  /** A shot swapped for footage found online: free, so it goes straight to the B-roll finder. */
  | { kind: 'broll'; phrase: number; beat: string; search: string }
  /** The person's own voice-over is wanted: waiting for the file. */
  | { kind: 'record'; reply: Reply }
  /** Something to say instead: what cannot be made again that way, and what can. */
  | { kind: 'say'; reply: Reply }
