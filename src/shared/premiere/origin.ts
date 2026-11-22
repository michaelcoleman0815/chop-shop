import { z } from 'zod'

/**
 * Where an edit made from a Premiere sequence came from (shared/premiere):
 * the sequence as it was exported, kept beside the copy of its picture and
 * sound that Cutalong plays, so what is added goes back onto it as tracks of
 * its own and the cuts in it never move.
 */
export const PremiereOriginSchema = z.object({
  /** Cutalong's own copy of the exported xmeml, which the round trip writes into. */
  xmlPath: z.string().min(1),
  /** Where the person's file was. */
  originalPath: z.string(),
  /** The sequence's name in Premiere. */
  name: z.string(),
  fps: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationSec: z.number().nonnegative(),
  /** Clips on its tracks, and the files they play. */
  clips: z.number().int().nonnegative(),
  files: z.number().int().nonnegative()
})
export type PremiereOrigin = z.infer<typeof PremiereOriginSchema>
