# The Cutalong site: design

The site extends the Cutalong design system (the published system and `src/renderer/src/cutalong/tokens.json`); it does
not replace it. The brand's colours, faces, radii, shadows, motion and voice are used as they are. What the site adds is
a page scale, dark values, and a few components the app does not have. Tokens live in `src/css/tokens.css`.

## Colour

Restrained: ground, card and ink do the work; coral marks the cut and nothing else.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--color-paper` | ground #F5F5F3 | oklch(17.7% 0.004 106.8) | The page |
| `--color-card` | #FFFFFF | oklch(21.7% 0.0057 106.9) | The slab nav, the two bands (Your Mac, the close) |
| `--color-paper-2` | well #ECEBE8 | oklch(19.9% 0.0039 106.7) | The switcher's track, the draft notice |
| `--color-paper-3` | beat #E7E6E2 | oklch(24% 0.0045 106.7) | Unplayed beats in the nav strip |
| `--color-ink` | #15161A | oklch(95.5% 0.0041 271.4) | Text, the primary button, the playing beat |
| `--color-ink-2` | #4B4D55 | oklch(83% 0.0086 271.3) | Secondary text |
| `--color-muted` | #5E6068 | oklch(73.5% 0.0089 271.3) | Meta, field edges (5.7:1 light, 8:1 dark) |
| `--color-rule` | #E8E7E4 | oklch(32% 0.0052 106.7) | Hairlines |
| `--color-accent` | coral #FF5A36 | the same | The mark, the playhead, the avatar. Never text or a fill |
| `--color-pill` | card | oklch(32% 0.0057 106.9) | The switcher's selected segment |

Dark is derived per token with its hue held, never inverted; coral keeps its value because the mark is never recoloured.
Shadows become hairline rings in dark. The product renderings use `--app-*`, the app's light palette, in both modes,
because the app has no dark mode.

## Type

Figtree for everything people read, self-hosted as a variable font; JetBrains Mono only for commands, timecode and file
names. Display is 700 at `--text-display` (84 px at 1440), tracked -0.04em; section heads at `--text-section` (56 px);
item titles at `--text-title`; body 17 px at 1.55, 360 in dark. The wordmark is Figtree 800, -0.045em, lower case.

## Space, shape, depth

Hallmark's spacing scale (`--space-3xs` 2 px to `--space-4xl` 144 px), a 1440 px container with a 64 px gutter, sections
120, 144 or 176 px apart. Radii are the brand's: 10 tile, 16 thumb, 24 card, 28 composer and plate, pills for buttons
and chips. Product plates carry the brand's `--shadow-frame` and a 1 px outline, pure black at 10% (white in dark).

## Components

- **The slab nav.** A full-width card bar, sticky. It carries the page's beat strip: one beat per section, the one in
  view in ink with its label, the coral playhead tracking the scroll. Hidden under 60rem.
- **Buttons.** One ink primary (52 px) per screen; the quiet secondary is a card pill with a hairline (44 px). Both
  press to 96%.
- **Plates.** A product rendering in a `data-slot`; a real capture replaces it without moving the layout.
- **The switcher.** Five radios as a segmented control; the pill springs on `--spring-gentle`; the panel fades up 4 px.
- **Questions.** Native `details`, the plus turning to a cross.
- **The draft notice and text slots.** A dashed outline marks what the owner must still decide.

## Motion

The brand’s durations (120, 180, 240, 320 ms) and curves. One authored moment: the hero’s 12 s loop, which starts at the
visitor’s first scroll, pointer move, touch or key, runs only in
view, pauses on hover, focus or its button, and never runs under reduced motion (the page shows its last frame). The
nav playhead follows the scroll one to one. Nothing else moves unless it is pressed, hovered or switched.

## Voice

The design system's: "I" for Cutalong, "you" for the creator, never "we"; plain words and exact numbers; no
exclamation marks, emoji, praise or hype; no dashes in copy.
