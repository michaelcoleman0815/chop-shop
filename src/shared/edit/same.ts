/**
 * Whether two values are the same, whatever order their keys are in. Ops
 * rebuild a cut as they change it, and a setting taken off and put back
 * lands last: compared as plain JSON, a cut that had not changed looked as if
 * it had, and made a version that changed nothing.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b)
}

/** JSON with every object's keys in order. */
function stable(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]])
        )
      : v
  )
}
