# 03 Staggers that read as one motion

## Why

Every stagger in the app uses even steps: a reply's parts arrive 40 ms apart (`(sibling-index() - 1) * var(--duration-gentle) / 6`), lists step by `/ 8`, project rows by `/ 16`. Even steps read as a queue, and on a long reply the last part waits 200 ms or more. The choreograph skill's rule: overlap the parts, shrink the gaps as you go, and cap the total so the group lands as one gesture. The avatar also scales in from 0.8 on every reply, a second entrance in a container that already has one.

## Where

`src/renderer/src/cutalong/motion.css`:

- about line 176: `transition-delay: calc((sibling-index() - 1) * var(--duration-gentle) / 6);` on the parts of a reply.
- about line 197: `html:not([data-cl-entering]) .cl-msg-assistant > .cl-assistant-avatar` starts at `scale: 0.8`.
- about line 242: `calc(min(sibling-index() - 1, 8) * var(--duration-gentle) / 6)` on clip cards.
- about line 324: `html[data-cl-entering] :is(.cl-continue-row > .cl-project, .cl-list > li)` with `/ 8`.
- about line 473: the rail labels with `calc(min(sibling-index(), 12) * var(--duration-calm) / 16)`.

## Change

1. Replace the even delay on reply parts with fixed, shrinking offsets, capped at 140 ms:

```css
.cl-msg-body > :nth-child(2) { transition-delay: 50ms; }
.cl-msg-body > :nth-child(3) { transition-delay: 90ms; }
.cl-msg-body > :nth-child(4) { transition-delay: 120ms; }
.cl-msg-body > :nth-child(n + 5) { transition-delay: 140ms; }
```

2. Clip cards: 0, 45 and 80 ms for the first three, 100 ms for any after.
3. Remove the avatar's scale-in. It fades with the first part, or (in the chosen direction) it only marks the newest reply and needs no entrance at all.
4. Lists and project rows on a screen change: drop the stagger. The view transition already moves the screen; a second wave inside it is the "double entrance" in the main report.
5. Rail labels: keep a single fade with no per-item delay.

## Check

- Pause `document.getAnimations()` when a clip set reply arrives: the last part's delay is 140 ms or less, and nothing scales.
- Switch screens with the rail: rows arrive with the screen, not after it.
- Less motion on: everything fades in together.
