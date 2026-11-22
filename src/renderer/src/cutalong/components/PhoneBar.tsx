/**
 * The phone's bottom bar on its top-level screens: your edits, one New edit in
 * the middle (the screen's one primary), and your brand. The rest of the rail
 * (presets, what I've learned, settings) stays in the menu in the top corner.
 * Shown only on a phone (App.tsx), on Start, Your edits and Brand.
 */
export type BarPlace = 'projects' | 'brand' | null

export function PhoneBar({
  current,
  onEdits,
  onNew,
  onBrand
}: {
  current: BarPlace
  onEdits: () => void
  onNew: () => void
  onBrand: () => void
}): JSX.Element {
  return (
    <nav className="cl-phonebar" aria-label="Cutalong">
      <button
        type="button"
        className={`cl-phonebar-tab${current === 'projects' ? ' on' : ''}`}
        aria-current={current === 'projects' ? 'page' : undefined}
        onClick={onEdits}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <rect x="3.5" y="7.5" width="17" height="12" rx="3" />
          <path d="M6.5 4.5h11" />
        </svg>
        Edits
      </button>
      <button type="button" className="cl-phonebar-new" onClick={onNew}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        New edit
      </button>
      <button
        type="button"
        className={`cl-phonebar-tab${current === 'brand' ? ' on' : ''}`}
        aria-current={current === 'brand' ? 'page' : undefined}
        onClick={onBrand}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3.5 14.1 9l5.4 2-5.4 2L12 18.5 9.9 13l-5.4-2 5.4-2Z" />
        </svg>
        Brand
      </button>
    </nav>
  )
}
