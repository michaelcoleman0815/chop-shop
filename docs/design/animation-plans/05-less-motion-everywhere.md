# 05 Less motion, everywhere

## Why

The motion system already honours reduced motion well: `--cl-travel` drops to 0, so things fade instead of travelling. Two places bypass it. The thread scrolls smoothly to every new message from script, and the toggle switch springs past its end. A spring with overshoot on a tap also has no momentum to explain it (Emil: bounce only when a gesture carries speed).

## Where

- `src/renderer/src/cutalong/screens/Thread.tsx` (about line 14):

```ts
end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
```

It runs on every message change, including while a reply streams in.

- `src/renderer/src/cutalong/motion.css` (about line 403): the toggle knob

```css
transition:
  translate var(--duration-calm) var(--spring-gentle),
  scale var(--duration-calm) var(--spring-gentle),
```

`--spring-gentle` (in `tokens.css`) is a `linear()` curve that overshoots to 1.037.

## Change

1. In `Thread.tsx`, choose the behaviour from the setting, and skip the scroll when the reader has scrolled up:

```ts
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
end.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'end' })
```

If Cutalong gains its own Less motion switch (the chosen direction adds one under Settings, Look), read that too.

2. Give the toggle knob `var(--duration-base) var(--ease-enter)` (no overshoot). Keep `--spring-gentle` for the segmented control's sliding pill, which moves across a distance and can be interrupted.

## Check

- macOS Reduce motion on: new messages appear at the bottom with no scroll animation; the knob moves without overshoot.
- With it off: smooth scroll as today, and the knob settles without passing its end (step it at 60 percent and 80 percent: its position never exceeds the final one).
