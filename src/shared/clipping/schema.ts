import { z } from 'zod'
import { EditDocSchema } from '../edit/schema'

/**
 * A clip set: the short clips /clipping cut from one or more long
 * recordings, kept in the project beside the chat that made them.
 *
 * Each clip is its own edit (an EditDoc on the recording it came from, with
 * only that moment's words), so it opens in the editor and changes like any
 * edit: notes, commands, versions and undo. The set is one entry in the
 * project, never one project per clip, so the rail lists the chat once.
 *
 * Every field added later is optional, so a set saved by this version still
 * reads in the next one.
 */

/** Stretches a clip never comes from, and why. */
export const LEAVE_OUT_KINDS = [
  'worship',
  'music',
  'furniture',
  'announcements',
  'giving',
  'sponsor',
  'warmup',
  'goodbye'
] as const
export type LeaveOutKind = (typeof LEAVE_OUT_KINDS)[number]

export const RegionSchema = z.object({
  kind: z.enum(LEAVE_OUT_KINDS),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  /** How the reply names it: "the worship set", "starting soon", "a break". */
  label: z.string()
})
export type Region = z.infer<typeof RegionSchema>

/** Who chose the moments. */
export const PICKERS = ['claude', 'local', 'measured'] as const
export type Picker = (typeof PICKERS)[number]

export const ClipSchema = z.object({
  /** c1, c2, ... in the order they were found, across every run. */
  id: z.string().min(1),
  /** The /clipping run that found it. */
  run: z.number().int().positive(),
  /** The recording it is cut from. */
  source: z.string().min(1),
  /** Where the moment sits in the recording, word to word, as found. */
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  title: z.string(),
  /** The opening line, as said. */
  hook: z.string(),
  /** Why it stands on its own, in a sentence. */
  reason: z.string(),
  score: z.number(),
  /** False once dropped from the set; Export all leaves it out. */
  kept: z.boolean(),
  doc: EditDocSchema,
  /** The last export of this clip. */
  exported: z.object({ path: z.string(), version: z.number().int().positive(), at: z.string() }).nullable().optional()
})
export type Clip = z.infer<typeof ClipSchema>

export const ClipRunSchema = z.object({
  n: z.number().int().positive(),
  at: z.string(),
  by: z.enum(PICKERS),
  /** The model that picked, when one did. */
  model: z.string().nullable().optional(),
  /** What the person asked, as typed after the command. */
  asked: z.string(),
  recordings: z.array(
    z.object({
      path: z.string().min(1),
      durationSec: z.number().nonnegative(),
      /** The kind of recording it was cut as (shared/clipping/profile). */
      profile: z.string(),
      left: z.array(RegionSchema)
    })
  )
})
export type ClipRun = z.infer<typeof ClipRunSchema>

export const ClipSetSchema = z.object({
  v: z.literal(1),
  runs: z.array(ClipRunSchema),
  clips: z.array(ClipSchema)
})
export type ClipSet = z.infer<typeof ClipSetSchema>
