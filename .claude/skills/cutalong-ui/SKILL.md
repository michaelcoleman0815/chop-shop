---
name: cutalong-ui
description: How to build and change Cutalong's interface (src/renderer/src/cutalong) so it stays one calm system. Use before adding or changing any screen, component, style, copy or icon in Cutalong, and when checking how a change looks.
---

# Building Cutalong's interface

Cutalong is a video editor people talk to. The interface is calm so the video is the loud part. The design system is published at https://claude.ai/artifact/AsZpkLeXa7pLaqMZkipqLh; `src/renderer/src/cutalong/tokens.json` is its copy, and `tokens.test.ts` fails if `tokens.css` drifts from it.

## Rules

1. **One thing per screen.** Start is a question and a composer. A thread is a reply and its buttons. The editor is a preview, notes and the beat strip. If a second thing wants the same screen, it goes behind a button, a menu or Details.
2. **Tokens only.** Every colour, space, radius and shadow comes from `tokens.css`, or reuses a rule already in `cutalong.css`. Components carry no colour values of their own.
3. **Coral marks the cut and nothing else**: the mark, the assistant's avatar and the playhead. Never text, never a button fill.
4. **One primary button per view** (ink fill). Everything else is secondary (card with a hairline) or text.
5. **Pills for buttons and chips**, `--radius-card` for panels, `--radius-composer` for the composer and the preview well. Shadows are few: `--shadow-composer` on the composer, `--shadow-frame` on the video, `--shadow-tab` on the selected item of the rail or a segmented control, and the one lifted shadow `cutalong.css` already gives things that float (menus, the slash menu, the toast).
6. **Figtree for everything, JetBrains Mono for commands, timecode and file names.** Fonts are bundled Latin subsets: the content security policy only loads fonts from the app itself, so nothing from the web and nothing inlined as `data:`.
7. **Numbers live behind Details.** Show a plain sentence first and at most three facts as chips.

## Motion

Cutalong moves the way a good editor works: quickly, without fuss, and only when something changes. Styles are in `motion.css`, the few pieces that need script in `motion.tsx`, and every value is a token in `tokens.css`.

- **How fast.** `--duration-fast` 120 ms for hover, press, focus and things clearing the way; `--duration-base` 180 ms for menus appearing and toasts or notes leaving; `--duration-gentle` 240 ms for messages, notes, list items and toasts arriving, and progress; `--duration-calm` 320 ms for screen changes, the rail, shared elements, a new version and the spring. Nothing takes longer, apart from a short stagger.
- **Which curve.** Arrive with `--ease-enter`, leave sooner with `--ease-exit`, move between two places with `--ease-standard`. What a hand moves (a switch, a segmented control's pill) springs on `--spring-gentle`.
- **What moves.** Screens fade through with an 8 px rise; the composer carries from Start into the thread, and footage grows from the card that opened it into the preview. The rail grows from its edge while names and chats fade and slide in at their final size and the main column glides. The user's bubble rises in; a reply's sentence, chips and buttons follow 40 ms apart. Progress fills ease. Menus scale and fade in from the edge they open on. Buttons press to 96% and hovers ease. Lists stagger in as their screen opens and removed rows collapse. Toasts rise in and fall away. The playhead moves every frame.
- **The loading signal** is the mark's dashed bar marching: on the assistant beside a progress row, in the send button while Cutalong works, and in a toast that counts up. Never a spinner.
- **What never moves.** The footage itself (no zoom or parallax; a new version only crossfades), the mark's solid bar, text being read (nothing reflows mid-animation), the layout (only transform, opacity and paint-only properties such as a clip or a dash offset animate; never width, height, top or left), anything idle (only the marching bar loops, and only while work runs), and coral (motion never puts coral anywhere new).
- **Building it.** A new thing arriving takes an `@starting-style` transition in `motion.css`. Remove a row with `collapse()`, let something fall away with `useLingering()`, fill a progress bar with `grow()`, and change a whole screen with `viewTransition()`. In a View Transition, name only small things: the page stays live underneath, and whatever only changes place moves as a live element with a transform (as the main column does when the rail moves), so it stays light even without a GPU. Read durations and curves from tokens; never write milliseconds or a new curve.
- **Reduced motion.** `--cl-travel` drops to 0, so opacity still changes and nothing travels, scales or springs; screens dissolve and the marching bar breathes instead.
- **Checking motion.** Step a transition by pausing `document.getAnimations()` at fixed fractions and screenshot each step; record frame times with `requestAnimationFrame` and long tasks with a `PerformanceObserver`, aiming for a 95th percentile under 16.7 ms. The preview needs a server that answers Range requests, or its video cannot seek.

## Voice

A helpful editor sitting next to you: first person, plain words, exact numbers. "v3 is ready. The hook word is bigger and the ending stays on you." No exclamation marks, no emoji, no praise, and never the word clone. Labels are verbs that say what happens ("Apply 2 notes as v4"). Seconds read as `0.15 s`, `1.8 s`, `12 s` (use `seconds()`), running times as `0:52` (use `clock()`).

## Where things are

- `App.tsx`: the rail and one screen at a time. `useCutalong.ts` holds the session; every change to the edit goes through `applyAsVersion` so it becomes a named version.
- `components/`: `ui.tsx` (Mark, Button, IconButton, icons), `Composer`, `Message`, `BeatStrip`, `Sidebar`.
- `screens/`: Start, Thread, Editor, Brand, Library (Projects and Presets), Settings.
- `motion.css` and `motion.tsx`: how everything moves (see Motion).
- `api.ts`: the slice of the preload API Cutalong uses. Add a method there and to `mock.ts` together.
- Shared logic belongs in `src/shared/` with tests, not in components.

## Checking a change

1. `npm run typecheck` and `npm test`.
2. `npx electron-vite build`, then serve `out/renderer` (for example `python3 -m http.server` from that folder). In a plain browser `api.ts` uses the mock, which answers with the real shared logic, so every screen can be reached.
3. Drive it with Playwright at 1280 x 840 and look at the screenshots: drop files on `.cl-composer` with a synthetic `DragEvent`, type into `#cl-ask`, and send with the `Send` button. Check focus states, long titles, empty states and the rail both open and closed.
