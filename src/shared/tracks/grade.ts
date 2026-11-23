import { z } from 'zod'
import { LookSchema } from '../edit/look'

/**
 * What an adjustment clip grades with: the look the whole picture can wear
 * (shared/edit/look), its colour and its vignette, and a blur in design
 * pixels. A leaf beside the track schema, so the schema includes it without
 * a cycle.
 */
export const GradeSchema = LookSchema.pick({
  exposure: true,
  contrast: true,
  saturation: true,
  temperature: true,
  tint: true,
  lift: true,
  vignette: true
}).extend({ blur: z.number().min(0).max(200).optional() })
export type Grade = z.infer<typeof GradeSchema>
