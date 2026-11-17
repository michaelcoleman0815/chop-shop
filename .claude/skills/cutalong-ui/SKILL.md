---
name: cutalong-ui
description: How to build and change Cutalong's interface (src/renderer/src/cutalong) so it stays one calm Lined Script system. Use before adding or changing any screen, component, style, copy or icon in Cutalong, and when checking how a change looks.
---

# Building Cutalong's interface

Cutalong is a video editor people talk to. Its direction is **Lined Script**: the transcript is the edit, so the app reads like a shooting script, and it should look heavenly doing it. Luminous paper on a softly lit desk, generous air, replies set beautifully in a serif, versions as revision pages in gentle tints, motion that floats in and settles. Dark mode is a calm night page, never a void. The interface stays quiet so the video is the loud part.

The design system is published at https://claude.ai/artifact/AsZpkLeXa7pLaqMZkipqLh; `src/renderer/src/cutalong/tokens.json` is its copy, and `tokens.test.ts` fails if `tokens.css` drifts from it, in either theme. The thinking behind the direction is in `docs/design/README.md`, and the clickable reference is `docs/design/prototype/index.html` (Lined Script in its picker).

## Rules

1. **One thing per screen.** Start is a question and a composer. A thread is a reply and its buttons. The editor is a preview, the notes or the script, and the beat strip. If a second thing wants the same screen, it goes behind a button, a menu or Details.
2. **Tokens only.** Every colour, space, radius and shadow comes from `tokens.css` (light and dark), or reuses a rule already in `cutalong.css`. Components carry no colour values of their own. The only literals are footage colours on the picture itself (dips to black or white, caption white).
3. **Paper, ink and soft greys.** `--ground` is the desk (with `--glow`, a soft light from above), `--card` and `--card-2` are paper, `--well` is where footage and your own words sit, `--line`, `--line-mid` and `--line-strong` are hairlines, button edges and field edges (3:1).
4. **Coral is now, and the mark.** The playhead is coral, and so is the mark's dashed bar. Nothing else: never text, never a fill, never a glow, never a second coral thing on a screen. The assistant's tile carries the mark beside the newest reply only.
5. **Blue pencil picks.** `--pick` marks a stretch picked on the strip and the script lines it covers. **Revision colours** (`--rev-1` white to `--rev-6` goldenrod, then again) belong to versions: a version's tab, the beats while it is on screen (the editor sets `--rev`), a note's number. Use `revisionOf(n)` from `revisions.ts`; never pick a tint by hand.
6. **One primary button per view** (ink fill). Everything else is secondary (paper with a `--line-mid` edge) or text. In a thread only the newest reply keeps its primary; older ones step down on their own (CSS, `:has()`), so never add a second.
7. **Type.** Figtree for the interface; **Source Serif 4** for what is read: replies (18/29, at most 36em, `text-wrap: pretty`), the script (16.5/27), notes (italic, pencilled). JetBrains Mono only for commands, timecode and file names. Figures are tabular wherever they count or tick. Fonts are bundled Latin subsets (`fonts.css`, `fonts/`, licences beside them): the content security policy loads fonts only from the app, so nothing from the web and nothing inlined as `data:`. A new face needs its OFL or similar licence file in `fonts/`.
8. **Shapes.** Pills for buttons, chips and segmented controls; `--radius-card` for sheets (notes, script, menus, toasts, sections); `--radius-thumb` for posters and Details; `--radius-composer` for the composer and the preview well. Shadows are soft light: `--shadow-page` under a resting sheet, `--shadow-float` under menus and toasts, `--shadow-composer`, `--shadow-frame`, `--shadow-tab` for the forward revision tab or segment.
9. **Numbers live behind Details.** A plain sentence first, at most three facts as chips.
10. **States say so three ways.** Disabled: a paler fill, muted words, the not-allowed cursor. Errors: `--error` on the field's edge and the message, with an icon (`.cl-field-msg.error`); success in `--ok`. Focus is a 2 px ink ring, the composer's included.
11. **Hover needs a pointer.** Hover rules live inside `@media (hover: hover) and (pointer: fine)`; the phone build shares these styles.

## Components to reach for

- **Revision tabs** (`Revisions` in `Editor.tsx`, `.cl-revisions`, `.cl-rev-tab`): the newest versions in their colours; the one on screen sits forward and keeps the `cl-version` class. A tab brings an older version back as the newest (`app.showVersion`).
- **The script** (`ScriptPanel`): numbered lines with a coverage line in the margin (ink for the line playing, blue pencil when picked), an asterisk on every line the revision changed (`changedBeats()`), and open notes pencilled in the margin (`.cl-margin-note`).
- **Notes** (`.cl-note`): no box; a hairline, a number in the revision's tint, the words in italic serif.
- **Fields and steps for key setup**: `.cl-field` with `aria-invalid`, `.cl-field-msg` (`.error`, `.ok`), and `.cl-steps` (numbered sheets; `.now` for the current step, `.done` when finished).
- **Toasts** float at the top right under the header, on paper, and never cover the beat strip.

## Motion

Lined Script moves the way light settles: things arrive softly, nothing jerks, everything is calm. Styles are in `motion.css`, the few pieces that need script in `motion.tsx`, and every value is a token.

- **How fast.** `--duration-fast` 120 ms for hover, press, focus and anything leaving; `--duration-base` 180 ms for menus and toggles; `--duration-gentle` 260 ms for arrivals (a reply, a note, a toast, a revision); `--duration-calm` 340 ms for screens, the rail, shared elements and a new version.
- **Which curve.** Arrive on `--ease-enter` (quick to start, then floating to rest). Leave on `--ease-exit`, which also eases out and is shorter: nothing eases in. Move between two places on `--ease-standard`. `--spring-gentle` settles without overshooting; nothing bounces unless a hand threw it.
- **What moves.** A reply arrives as one gesture: the sentence rises 8 px and comes into focus from a 2 px blur, then its facts, cards and buttons follow at 50, 90, 120 and 140 ms. Clip cards overlap at 0, 45 and 80 ms. Screens fade through with a rise; the composer carries from Start into the thread (the old contents empty before the new fill, never both at once); footage grows from the card that opened it. The brand menu scales from its corner when a pointer opened it. Toasts float down under the header and drift up as they go. The playhead moves every frame.
- **What appears at once.** Anything the keyboard opened: the slash menu, a menu opened with Enter or Space. A list that arrives with its screen gets no second wave of its own.
- **The loading signal** is the mark's dashed bar marching beside a working reply, in the send button and in a counting toast, with a thin pencil line for progress. Never a spinner.
- **What never moves.** The footage itself, text being read, the layout (only transform, opacity, filter and paint-only properties animate), anything under a scrubbing pointer, anything idle, and coral.
- **Building it.** A new thing arriving takes an `@starting-style` transition in `motion.css`. Remove a row with `collapse()`, let something fall away with `useLingering()`, fill progress with `grow()`, change a screen with `viewTransition()`. Read durations and curves from tokens; never write milliseconds or a new curve outside `tokens.css` and the stagger offsets above.
- **Reduced motion.** `--cl-travel` drops to 0: opacity still changes, nothing travels, blurs, scales or springs; the thread jumps to new turns instead of scrolling; screens dissolve and the marching bar breathes.
- **Checking motion.** Step a transition by pausing `document.getAnimations()` at fixed fractions and screenshot each step; record frame times with `requestAnimationFrame` and long tasks with a `PerformanceObserver`, aiming for a 95th percentile under 16.7 ms. The preview needs a server that answers Range requests, or its video cannot seek.

## Voice

A helpful editor sitting next to you: first person, plain words, exact numbers. "v3 is ready. The hook word is bigger and the ending stays on you." No exclamation marks, no emoji, no praise, no middle dots or dashes between phrases, and never the word clone. Labels are verbs that say what happens ("Apply 2 notes as v4"). Seconds read as `0.15 s`, `1.8 s`, `12 s` (use `seconds()`), running times as `0:52` (use `clock()`). Versions can be named by their pages: "v3, the pink pages".

## Where things are

- `App.tsx`: the rail and one screen at a time. `useCutalong.ts` holds the session; every change to the edit goes through `applyAsVersion` so it becomes a named version.
- `components/`: `ui.tsx` (Mark, Button, IconButton, icons), `Composer`, `Message`, `BeatStrip`, `Sidebar`, `ClipSet`, `BrandSwitch`.
- `screens/`: Start, Thread, Editor (with `Revisions` and `ScriptPanel`), Brand and BrandRules, Library (Projects and Presets), Settings and ClaudeFrames.
- `tokens.css` and `tokens.json` (both themes), `fonts.css` and `fonts/`, `revisions.ts` (revision colours, changed lines).
- `motion.css` and `motion.tsx`: how everything moves (see Motion).
- `api.ts`: the slice of the preload API Cutalong uses. Add a method there and to `mock.ts` together.
- Shared logic belongs in `src/shared/` with tests, not in components.

## Checking a change

Heavy commands (typecheck, a full test run, a build, any app run) go through the shared lock so only one runs at a time: `flock /tmp/claude-0/-home-user-chop-shop/53b389d3-4ba3-5f34-8abd-cb88ea18110d/scratchpad/heavy.lock -c '<command>'`.

1. `npm run typecheck` and `npm test`.
2. `npx electron-vite build`, then serve `out/renderer` (for example `python3 -m http.server` from that folder). In a plain browser `api.ts` uses the mock, which answers with the real shared logic, so every screen can be reached.
3. Drive it with Playwright at 1440 x 900, 1280 x 840 and 960 x 640, light and dark (`colorScheme: 'dark'`), and look at the screenshots: drop files on `.cl-composer` with a synthetic `DragEvent`, type into `#cl-ask`, and send with the `Send` button. Check focus states, long titles, empty states, the rail open and closed, and that the video stays big at 960.
4. Run Hallmark's lint (`node ~/.claude/skills/hallmark/scripts/sloplint.mjs <files> --scope app --url <served url>`) and Impeccable's detector live on each screen (`.claude/skills/impeccable/scripts/impeccable detect --cdp <port>`), and fix what they find.
5. Ask of every screenshot: does it still look heavenly? Luminous, airy, gently tinted, beautifully set, and calm.
