# 02 Exits ease out

## Why

`--ease-exit` is `cubic-bezier(0.4, 0, 1, 1)`, an ease-in: it starts slowly and ends at full speed. On a toast that is leaving, the first 100 ms barely move and then it snaps away, which reads as hesitation. Emil's rule: enter and exit both ease out; an exit is simply shorter.

## Where

- `src/renderer/src/cutalong/tokens.css` (about line 52): `--ease-exit: cubic-bezier(0.4, 0, 1, 1);`
- `src/renderer/src/cutalong/tokens.json`: the same token.
- `src/renderer/src/cutalong/motion.css`:
  - `.cl-toast.leaving` (about line 434) uses `transition-timing-function: var(--ease-exit)` over `var(--duration-base)`.
  - `::view-transition-old(*.cl-note):only-child` (about line 704) uses `var(--ease-exit)` for `cl-slide-out`.
- `src/renderer/src/cutalong/motion.tsx`: `collapse()` and `useLingering()` read the same token for removals.

## Change

1. Redefine the token as an ease-out, so every exit improves at once:

```css
--ease-exit: cubic-bezier(0.23, 1, 0.32, 1);
```

Mirror it in `tokens.json`.

2. Make exits shorter than entries: `.cl-toast.leaving` goes from `var(--duration-base)` (180 ms) to `var(--duration-fast)` (120 ms), and travels half as far (`var(--space-1)` instead of `var(--space-2)`).
3. Update the comment at the top of `motion.css` ("leave sooner with ease-exit") so it says exits ease out and are shorter.

## Check

- Step the toast's exit with `document.getAnimations()` paused at 25 percent: it should already be more than half transparent. Before this change it is still about 90 percent opaque at 25 percent.
- Removing a note: the note fades and slides out in 120 ms with no visible pause at the start.
- Less motion on: the toast fades without travelling.
