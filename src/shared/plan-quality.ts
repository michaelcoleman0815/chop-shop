/**
 * How hard Claude works on an edit before handing it over, as the person sets it: planned once, or also judged by a
 * critic who has not seen the plan and redone where it is not good enough (main/plan-critic), once or twice, with a
 * graphic designed for the video alone at the best (main/plan-design). Better videos, for more of the person's own
 * Anthropic credit and a longer wait, so it starts at the least.
 */
export const PLAN_QUALITIES = ['quick', 'careful', 'best'] as const
export type PlanQuality = (typeof PLAN_QUALITIES)[number]

/** What each comes to is priced before an edit starts and kept to as it runs (shared/setup/cost, main/plan-quote). */
export const PLAN_QUALITY_INFO: Record<PlanQuality, { label: string; redos: number; does: string }> = {
  quick: { label: 'Quick', redos: 0, does: 'I plan it once and hand it over.' },
  careful: {
    label: 'Careful',
    redos: 1,
    does: 'A critic who has not seen the plan scores every graphic and camera move, and I redo what is not good enough. Usually a minute or two longer.'
  },
  best: {
    label: 'Best',
    redos: 2,
    does: 'I design a graphic for this video alone, a critic who has not seen the plan scores everything, and I redo what is not good enough, up to twice. Usually three or four minutes longer.'
  }
}

/** The quality a setting names; the least when it names none. */
export const planQualityOf = (v: unknown): PlanQuality =>
  (PLAN_QUALITIES as readonly unknown[]).includes(v) ? (v as PlanQuality) : 'quick'
