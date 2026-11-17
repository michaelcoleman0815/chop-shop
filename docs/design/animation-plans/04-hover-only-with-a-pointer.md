# 04 Hover only where there is a pointer

## Why

`.cl-beat:hover` lifts a beat block by half a space step. The strip is scrubbed and dragged constantly, so the blocks bob under the pointer while the playhead moves, and on a touch screen the lift sticks after a tap. 14 other `:hover` rules in `cutalong.css` sit outside any hover media query, so the phone build shows hover colours that stay after a tap. Emil and mobile-native agree: gate hover behind `(hover: hover) and (pointer: fine)`, and do not move things under a dragging pointer.

## Where

- `src/renderer/src/cutalong/motion.css` (about line 281):

```css
.cl-beat:hover {
  translate: 0 calc(var(--space-1) / -2 * var(--cl-travel));
}
```

- `src/renderer/src/cutalong/cutalong.css`: every rule with `:hover` that is not inside `@media (hover: hover) and (pointer: fine)`. Find them with `grep -n ":hover" cutalong.css`; at `6ffa7e7` there are 14, including `.cl-beat:hover { background: #dddcd7; }` (a colour literal too).

## Change

1. Delete the beat lift. A hovered beat changes its label colour only, inside the media query.
2. Wrap the other hover rules:

```css
@media (hover: hover) and (pointer: fine) {
  /* the existing :hover rules, unchanged except for colour literals */
}
```

3. While moving them, replace colour literals with tokens (`#dddcd7` becomes the hover step of `--beat`, which needs a token in `tokens.css`).

## Check

- Drag across the strip with a mouse: no block moves vertically.
- In Chrome's device mode with touch, tap a beat and a button: nothing stays highlighted after the tap.
- `grep -n ":hover" cutalong.css motion.css` lists only lines inside a hover media query.
