import { z } from 'zod'

/** Where the faces are in a recording, found now and then (shared/faces). A leaf module, so the edit's schema can hold it. */
const n = z.number().finite()
export const FacesReadingSchema = z.object({
  /** Seconds between readings. */
  everySec: n.positive(),
  samples: z.array(z.object({ t: n, faces: z.array(z.tuple([n, n, n, n])).max(12) })).max(3000)
})
export type FacesReading = z.infer<typeof FacesReadingSchema>
