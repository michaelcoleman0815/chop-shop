/**
 * The Chop Shop mark: two slabs knocked out of alignment, drawn to the brand
 * construction (slab 78x33, gap 9, offset 24 running right, radius 8). On ink
 * the top slab goes paper and the accent lifts to Chop Red Light.
 */
export default function Mark({ height = 22 }: { height?: number }): JSX.Element {
  return (
    <svg
      width={(height * 102) / 75}
      height={height}
      viewBox="0 0 102 75"
      fill="none"
      aria-hidden="true"
    >
      <rect x="0" y="0" width="78" height="33" rx="8" fill="var(--paper)" />
      <rect x="24" y="42" width="78" height="33" rx="8" fill="var(--accent)" />
    </svg>
  )
}
