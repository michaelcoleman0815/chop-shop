/** How long making a new video's chat may take before the window stops waiting for it (useCutalong's newChat). */
export const NEW_CHAT_WAIT_MS = 15_000

/** What a piece of work came to, or 'late' once `ms` have passed without it. The work goes on either way. */
export function inTime<T>(work: Promise<T>, ms: number): Promise<T | 'late'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}
