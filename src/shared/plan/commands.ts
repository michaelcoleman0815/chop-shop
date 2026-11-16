import { z } from 'zod'
import { PROFILES } from '../raw/profiles'
import { MOUTH_MODES } from '../vision/mode'

/**
 * Cutalong's own commands as steps Claude can choose in a plan, beside the
 * edit ops: the same executors the slash commands run (the length cutter,
 * the takes, the presets, a music bed from the Music folder, /clipping,
 * /vlog, export and the rest), chosen with structured arguments that are
 * checked with zod like every other part of a plan.
 *
 * How a command registers itself:
 * - Every slash command in the slash menu is already a step: Claude sees
 *   the menu in the request (<commands>) and runs one with
 *   {"op":"run","command":"music","rest":"lofi"}, which goes through the
 *   same dispatch as typing /music lofi. A new command in the menu needs
 *   nothing more; its summary there, with an example, is what teaches it.
 * - A command whose arguments deserve a shape of their own (a length in
 *   seconds, a take by number) is added to PLAN_COMMANDS below: its op name,
 *   one line teaching it, and its slots, every one required, with '', 0, []
 *   or false for the usual. The plan's schema, the planner's instructions
 *   and the check of each step are made from this list, and the editor runs
 *   it in carry.ts (renderer), keyed by its op name.
 */

export interface PlanCommandSpec {
  /** The step's op name in a plan. */
  op: string
  /** How the planner is taught it: what it does, with a step that would parse. */
  teach: string
  /** Its slots, besides op. Every slot is required: the schema stays inside structured output's limits. */
  slots: z.ZodRawShape
}

const PROFILE_IDS = PROFILES.map((p) => p.id) as [string, ...string[]]

export const PLAN_COMMANDS = [
  {
    op: 'run',
    teach:
      'any command in the <commands> block, with what the person would type after it: {"op":"run","command":"tighten","rest":""}, {"op":"run","command":"music","rest":"lofi"}, {"op":"run","command":"transition","rest":"whip 0.3"}. It runs exactly as if they typed it after a slash.',
    slots: { command: z.string(), rest: z.string() }
  },
  {
    op: 'length',
    teach:
      'cut the whole video to a length with Cutalong’s own cutting, which takes retakes, pauses and the weakest lines first and keeps the opening, each section’s first line and the ending: {"op":"length","targetSec":480,"minSec":0,"maxSec":0,"under":false,"intro":false,"keepAll":false}. targetSec for one length, or minSec and maxSec for a range, with under true when it only has to come in under maxSec; intro true starts it on the main point; keepAll true keeps every line and only tightens. 0 and false leave that part out.',
    slots: {
      targetSec: z.number(),
      minSec: z.number(),
      maxSec: z.number(),
      under: z.boolean(),
      intro: z.boolean(),
      keepAll: z.boolean()
    }
  },
  {
    op: 'take',
    teach:
      'play another take of a line in the <takes> block, by the line’s id and the take’s number: {"op":"take","line":"g2","take":2}. Use it rather than striking and unstriking a take by hand.',
    slots: { line: z.string(), take: z.number() }
  },
  {
    op: 'bring-back',
    teach:
      'bring back what was cut on request, by the name the <cut-on-request> block gives it: {"op":"bring-back","what":"the intro"}.',
    slots: { what: z.string() }
  },
  {
    op: 'music-track',
    teach:
      'put a music bed under the video from the person’s Music folder, a track whose name has these words, or "" to let them choose a file: {"op":"music-track","find":"upbeat"}. Change its level afterwards with the music op.',
    slots: { find: z.string() }
  },
  {
    op: 'clipping',
    teach:
      'cut many short clips from this edit’s recordings, each its own vertical edit: {"op":"clipping","count":0,"minSec":0,"maxSec":0,"funny":false,"topic":""}. count is how many (0 lets Cutalong choose), minSec and maxSec how long, funny the funny parts, topic what they are about.',
    slots: { count: z.number(), minSec: z.number(), maxSec: z.number(), funny: z.boolean(), topic: z.string() }
  },
  {
    op: 'vlog',
    teach:
      'tell this edit’s clips as a vlog’s story, or tell a vlog’s story again, with what the person asked of it in their own words: {"op":"vlog","ask":"8 minutes, open on the beach"}.',
    slots: { ask: z.string() }
  },
  {
    op: 'export',
    teach: 'export the video as this plan leaves it: {"op":"export"}. Only when asked, and always the last step.',
    slots: {}
  },
  {
    op: 'accept-offers',
    teach: 'make the cuts Cutalong offered in the <offers> block, when the person says yes to them: {"op":"accept-offers"}.',
    slots: {}
  },
  {
    op: 'profile',
    teach: `what kind of video this is, when the person says, which changes how pauses and takes are cut: {"op":"profile","kind":"podcast"}. Kinds: ${PROFILE_IDS.join(', ')}.`,
    slots: { kind: z.enum(PROFILE_IDS) }
  },
  {
    op: 'mouth',
    teach:
      'how the speaker’s mouth is used, when the person says: {"op":"mouth","mode":"sync"}. cuts+sync times the cuts to it and lines the sound up with it, sync only lines the sound up, off leaves it out.',
    slots: { mode: z.enum(MOUTH_MODES) }
  },
  {
    op: 'undo',
    teach: 'go back to the version before this one: {"op":"undo"}. Only when the person asks to undo, and as the only step.',
    slots: {}
  }
] as const satisfies readonly PlanCommandSpec[]

export type PlanCommandName = (typeof PLAN_COMMANDS)[number]['op']

export const PLAN_COMMAND_NAMES = PLAN_COMMANDS.map((c) => c.op) as PlanCommandName[]

/** Whether an op in a plan is one of Cutalong's commands rather than an edit op. */
export function isPlanCommand(op: { op: string }): op is PlannedCommand {
  return (PLAN_COMMAND_NAMES as string[]).includes(op.op)
}

/** One schema per command, made fresh each time: a shared schema object comes out as a $ref in JSON Schema. */
export function planCommandSchemas() {
  return PLAN_COMMANDS.map((c) => z.object({ op: z.literal(c.op), ...c.slots }))
}

const COMMAND_SCHEMA = z.discriminatedUnion(
  'op',
  planCommandSchemas() as unknown as [z.ZodObject<{ op: z.ZodLiteral<PlanCommandName> }>]
)

/** A command step as a plan carries it, its slots checked. */
export type PlannedCommand =
  | { op: 'run'; command: string; rest: string }
  | {
      op: 'length'
      targetSec: number
      minSec: number
      maxSec: number
      under: boolean
      intro: boolean
      keepAll: boolean
    }
  | { op: 'take'; line: string; take: number }
  | { op: 'bring-back'; what: string }
  | { op: 'music-track'; find: string }
  | { op: 'clipping'; count: number; minSec: number; maxSec: number; funny: boolean; topic: string }
  | { op: 'vlog'; ask: string }
  | { op: 'export' }
  | { op: 'accept-offers' }
  | { op: 'profile'; kind: string }
  | { op: 'mouth'; mode: (typeof MOUTH_MODES)[number] }
  | { op: 'undo' }

/** A command step checked against its slots, or null when it does not have their shape. */
export function readPlanCommand(value: unknown): PlannedCommand | null {
  const parsed = COMMAND_SCHEMA.safeParse(value)
  return parsed.success ? (parsed.data as PlannedCommand) : null
}

/** The planner's lines for every command, for its instructions. */
export function teachCommands(): string {
  return PLAN_COMMANDS.map((c) => `- ${c.teach}`).join('\n')
}

/** A plan, step by step, as the editor carries it out: edit ops that applied, run together, and commands, in order. */
export type PlanStep = { ops: unknown[] } | { command: PlannedCommand }

/** A question the planner asks instead of guessing, with the answers as buttons that send their words. */
export interface PlanQuestion {
  text: string
  options: string[]
}
