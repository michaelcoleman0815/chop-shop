# The Cutalong site: design

The site wears the app's look, Lined Script on set (`docs/design/`; the app's tokens, v4), with the
owner's "heavenly and alive" notes and the crew notes on top. It extends the app's system and does not replace it:
the colours, radii, shadows and curves are the app's. What the site adds is a page scale, colour blocks, stickers, the
living mark, two springs and the crew's characters. Tokens live in `src/css/tokens.css`.

## Colour

Luminous paper and ink. Coral is the cut (the playhead, the mark, Snip) and nothing else. The revision colours tint
pages, as they do in the app; as confident blocks they carry the sections around the product, never the product.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--color-paper` | oklch(96.9% 0.006 85), the desk | oklch(19.5% 0.018 268), a calm night page | The page |
| `--color-glow` | oklch(99.4% 0.012 90) | oklch(26% 0.032 262) | Light pooled on the paper behind the hero |
| `--color-card` | oklch(99.6% 0.003 90), a sheet | oklch(23.5% 0.02 268) | The window, the steps, the composer |
| `--color-ink` | oklch(25% 0.014 272) | oklch(94.5% 0.008 85) | Text, the primary button |
| `--color-ink-2`, `--color-muted` | 41%, 50% | 85%, 72% | Secondary text, meta |
| `--color-cut` | #FF5A36 | #FF6E4E | The playhead, the mark, Snip. Never text |
| `--rev-1` to `--rev-6` | white, blue, pink, yellow, green, goldenrod pages | the same hues at night | Revision pages in the product |
| `--block-*` | the revision hues, a step bolder (v4), lavender too | quiet night tints, as in the app | The bento, the tiles, the Mac and close blocks, and the highlighter. Ink on top in both |
| `--color-stage`, `-2`, `-line`, `--color-on-stage`, `-soft` | ink | a deeper night | The stage: the hero window's picture and beat strip sit on it in both looks, and inside it ink and rules point at its colours |
| `--crew-*` | blue, coral, yellow, green, pink, lavender | the same | The crew, constant in both looks, as footage is |

Dark is a calm night page: never a void, never inverted, hue held per token. Footage stand-ins keep their colours in
both looks. On a colour block, secondary and quiet text is the ink thinned (`--ink-on-block-2`, `--ink-on-block-3`),
so it takes the block's hue and never reads as grey on colour.

## Type

Headings are Figtree 800, tight (-0.045em), with one italic serif accent each: Source Serif 4's display italic at 440,
set 8% larger to match Figtree's x-height, on a highlighter swipe of a block colour (`--hl`: yellow, or the section's
own), which draws across the word as the heading arrives. Body and labels are Figtree at 17 to 18 px. What you read in the product
(Cutalong's replies, the script, the notes in its margin) is Source Serif 4 text, as in the app. JetBrains Mono is only
for timecode, commands and file names. Three families, all self-hosted.

## Space, shape, depth

Hallmark's spacing scale (`--space-3xs` 2 px to `--space-4xl` 144 px), a 1280 px container with a 64 px gutter (32 px
under 60rem, 20 px under 40rem), sections 120 to 200 px apart. Radii are the app's (4 to 20 px, 24 for the composer)
and pills for buttons and chips. Depth is soft light under lifted paper: `--shadow-page`, `--shadow-float`,
`--shadow-window`, in the paper's own hue, deeper at night.

## Components

- **The slab nav.** The paper, sticky, taking a hairline once the page moves under it. One action.
- **Buttons.** One ink primary per screen; the quiet secondary is a card pill with a hairline. Both press to 97%.
- **The living mark.** A soft, iridescent blob in two layers that turn against each other and breathe. It leads the
  hero, and in the product it leads the crew while they work. Asleep off screen.
- **The window.** The redesigned editor built at full fidelity inside the `hero-loop` slot: the picture, Cutalong's
  side page with the script, the composer and the beat strip. No drawn OS chrome.
- **Stickers and badges.** A scalloped sticker (a CSS mask over a pastel) for the version and the step numbers; a
  tilted ink badge for the new running time.
- **The crew.** Six blobs with two eye marks, drawn by code (`scripts/shapes.mjs`): Echo (sound, blue, wave-edged),
  Snip (the cut, coral, star-cornered), Quill (words, yellow, a leaf), Scout (finds things, green, an antenna nub),
  Tint (the look, pink, scalloped) and Reel (gets it out, lavender, a pill). Names live in `site.config.mjs`.
- **Colour blocks.** The bento of what you get, the proof tiles, the Mac and close blocks: a revision pastel, 20 px
  radius, ink type.
- **The proof page.** The real run's script on blue pages, the struck takes and the margin notes in serif.
- **What runs where.** A diagram, not a card: what stays on your Mac under a solid ink rule, dashed pills for what
  leaves it and where to.
- **Questions.** Native `details`, the plus turning to a cross.

## Motion

Composite only: `transform` and `opacity`, nothing else animates. The app's curves (`--ease-*`, `--spring-gentle`) plus
two springs with a hair of overshoot for arrivals: `--spring-settle` (cards settle) and `--spring-pop` (stickers and
the crew pop). Arrivals float up 18 px and settle once as they come into view.

The hero's loop is 14 s: the ask types, the living mark leads Echo in to find the pauses and Snip to cut it to length,
each hops once when done, the reply floats in with their credit, the takes are struck one by one, Snip lands on the
strip as it closes up, and v2 arrives on blue pages. It starts at the visitor's first scroll, pointer move, touch or
key, from the frame the page already shows, runs only while seen, and pauses on hover, focus or its button.

The crew moves only while working; idle is still. With reduced motion the loop does not run (the page shows its last
frame), arrivals simply show, the crew's faces only fade in, and the living mark only breathes in opacity.

## Voice

The design system's: "I" for Cutalong, "you" for the creator, never "we"; the crew show up in the work, never as chat;
plain words and exact numbers; no exclamation marks, emoji, praise or hype; no dashes in copy.
