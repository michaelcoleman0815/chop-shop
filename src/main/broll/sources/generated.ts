import type { BrollSource, Candidate, Fetched, FetchOptions, Moment } from '../../../shared/broll/types'

/**
 * The slot for generated B-roll. Generation itself belongs to the providers
 * being added in main/providers (fal, Google); nothing here makes a picture.
 * A provider that fills this slot offers what it would make for a moment as
 * candidates, says what each costs before anything is made, and makes the
 * file only when one is picked, through the same consent path as any other
 * paid call. Until one is registered, the slot answers with nothing and the
 * router leaves it out.
 */

export interface GenerationProvider {
  id: string
  name: string
  /** What making one shot would cost, in US dollars, said before anything is made. */
  quote(moment: Moment): Promise<{ dollars: number; said: string }>
  /** What it would make for the words: prompts and settings as candidates, nothing made yet. */
  propose(query: string, moment?: Moment): Promise<Candidate[]>
  /** Makes the picked one into the folder. Called only after the person said yes to its price. */
  make(candidate: Candidate, dir: string, opts?: FetchOptions): Promise<Fetched>
}

export function generatedSource(provider: GenerationProvider | null): BrollSource {
  return {
    id: 'generated',
    name: provider?.name ?? 'generation',
    kinds: ['video', 'image'],
    paid: true,
    async search(query, opts = {}) {
      if (!provider || !opts.paid) return []
      return provider.propose(query)
    },
    async fetch(c, dir, opts) {
      if (!provider) throw new Error('No generation service is set up yet.')
      return provider.make(c, dir, opts)
    }
  }
}
