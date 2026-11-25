import { z } from 'zod'

/**
 * A video's art direction: what it is about turned into a look, so two videos never come out of the same mould. Its
 * graphics wear it (theme directed); the idea is the one thing they share, kept with the edit so a later change
 * carries on from it. A leaf module, so the edit's schema can hold it.
 */
export const DirectionSchema = z.object({
  /** The look in a few words: "a courtroom: ink on cream, one red stamp". */
  idea: z.string().max(240).optional(),
  accent: z.string().max(16).optional(),
  second: z.string().max(16).optional(),
  display: z.string().max(40).optional(),
  body: z.string().max(40).optional(),
  script: z.string().max(40).optional(),
  ground: z.enum(['dark', 'light']).optional()
})
export type Direction = z.infer<typeof DirectionSchema>
