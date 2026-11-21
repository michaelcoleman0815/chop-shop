---
name: cutalong-ui
description: How to build and change Cutalong's interface (src/renderer/src/cutalong) so it stays one Lined Script system, heavenly and alive. Use before adding or changing any screen, component, style, copy, icon, shape or crew member in Cutalong, and when checking how a change looks.
---

# Building Cutalong's interface

Cutalong is a video editor people talk to. Its direction is **Lined Script, on set**: the transcript is the edit, so the app reads like a shooting script, and it should look heavenly and feel alive doing it. Luminous paper on a softly lit desk, generous air, replies set beautifully in a serif, versions as revision pages, and colour you can feel: the revision colours as confident pastel blocks, shapes with character, and a small crew of characters who do the work while one voice talks to you. Dark mode is a calm night page, never a void. Colour lives around the video, never on it: the footage stays the loudest thing on screen, and it sits on **the stage**, a dark surface in both themes, with the tools that act on it. Words stay on paper.

The design system is published at https://claude.ai/artifact/AsZpkLeXa7pLaqMZkipqLh; `src/renderer/src/cutalong/tokens.json` is its copy, and `tokens.test.ts` fails if `tokens.css` drifts from it, in either theme. The thinking behind the direction is in `docs/design/README.md`, and the clickable reference is `docs/design/prototype/index.html` (Lined Script in its picker).

## Rules

1. **One thing per screen.** Start is a question and a composer. A thread is a reply and its buttons. The editor is a preview, the notes or the script, and the beat strip. If a second thing wants the same screen, it goes behind a button, a menu or Details.
2. **Tokens only.** Every colour, space, radius, shadow, duration and curve comes from `tokens.css` (light and dark), or reuses a rule already in `cutalong.css`. Components carry no colour values of their own. The only literals are footage colours on the picture itself (dips to black or white, caption white) and the gloss on a dropped still.
3. **Paper, ink, soft greys, and the stage.** `--ground` is the desk (with `--glow`, a soft light from above), `--card` and `--card-2` are paper, `--well` is where footage and your own words sit, `--line`, `--line-mid` and `--line-strong` are hairlines, button edges, and the edges of fields and the composer (3:1). The composer is lifted paper: a field's `--line-strong` edge and a soft shadow; focused, its edge firms and a halo of blue pencil shows, never a heavy ring. **The stage** (`--stage`, `--stage-2`, `--stage-line`, `--on-stage`, `--on-stage-soft`, `--radius-stage`, `--shadow-stage`) holds footage and what acts on it: the editor's preview (`.cl-well`), the beat strip (`.cl-strip`), project stills, sample shoots, the welcome's demo. Put `.cl-stage` on anything else that belongs there. The stage is a scope as well as a surface: inside it `--ink`, `--line`, `--card` and friends point at the stage's tokens, so a button, a beat or a ring set on it needs no rules of its own.
4. **Coral is the cut.** The playhead, the mark's dashed bar, the warm core of the living mark, and Snip while Snip is cutting. Nothing else: never text, never a fill, never a second coral thing in one place. At rest (in the credits, on a note, on the Crew page, done with a part) Snip is salmon: `crewColour(id, resting)`, and `CrewFace` rests by itself whenever it is not at work. The assistant's tile carries the mark beside the newest reply only.
5. **The revision colours come three ways.** Use `revisionOf(n)` (`revisions.ts`) for versions and `block()`/`bloom()` (`shapes.ts`) for the rest; never pick a tint by hand.
   - `--rev-1` to `--rev-7` (white, blue, pink, yellow, green, goldenrod, salmon): gentle page tints behind the script and the strip for the version on screen (the editor sets `--rev`).
   - `--block-*` (blue, pink, yellow, green, gold, salmon, lavender): confident pastel blocks, a step bolder since v4, for a version's tab, a fact tile, a clip card, a preset card, a brand's hero, a crew card, an onboarding panel, an empty page. Ink and `--ink-soft` on them; `--muted` is too pale. After dark they are quiet night tints: yellow and gold lean amber and soft and pink stays dusty, because a dark yellow reads khaki, a dark gold olive and a dark pink maroon (`tokens.test.ts` holds them there).
   - `--bloom-*`: the deeper tone of each, for shapes: a brand's avatar, a sticker, a crew member, the living mark. Text on a bloom is `--on-bloom`, dark in both themes.
   An older reply's tiles settle to a calmer tint by themselves (`:has()`), so the newest reply is the one alive.
6. **Blue pencil picks.** `--pick` marks a stretch picked on the strip and the script lines it covers.
7. **One primary button per view** (ink fill; on the stage the scope makes it paper-filled). Everything else is secondary (paper with a `--line-mid` edge) or text. In a thread only the newest reply keeps its primary; older ones step down on their own. In the editor, Export steps down to secondary while notes wait to be applied, so applying them is the one primary.
8. **Type with a voice.** Display headings are big, bold and tight (Figtree 800: onboarding 96/92 and 72/70, Start 68/68, pages 40/44) with at most one word in the accent, the serif's italic on a highlighter swipe (`<span className="cl-accent">`, a typographic voice rather than stress, so not `<em>`; the swipe is `--hl`, yellow unless the version or step gives another block colour): "What are we *making*?", "Your *crew*". Never accent a name someone typed. **Source Serif 4** for what is read: replies (18/29, at most 36em, `text-wrap: pretty`), the script (16.5/27), notes (italic, pencilled), a working member's plain line. Small quiet labels beside the big type. JetBrains Mono only for commands, timecode and file names. Figures are tabular wherever they count or tick. Fonts are bundled Latin subsets (`fonts.css`, `fonts/`, licences beside them): the content security policy loads fonts only from the app.
9. **Shapes with character.** Pills for buttons, chips and segmented controls; `--radius-stage` for the stage; `--radius-card` for sheets; `--radius-thumb` for posters and Details; `--radius-composer` for the composer. Blocks are generous (18 to 28 px). Organic shapes come from `shapes.ts` (`SHAPES`, drawn by code as one smooth path): a `Blob`, a `Sticker` (a word or number on a shape: "new" on a version made while you watched), a `BrandAvatar`. Shadows are soft light: `--shadow-page`, `--shadow-float`, `--shadow-composer`, `--shadow-frame`, `--shadow-tab`.
10. **Big numbers, small labels.** A plain sentence first, then at most three facts as tiles (`Facts` in `Message.tsx`, `factParts()` in `facts.ts`): a big number with a label under it, or a short phrase when there is no number. The rest lives behind Details.
11. **States say so three ways.** Disabled: a paler fill, muted words, the not-allowed cursor. Errors: `--error` on the field's edge and the message, with an icon (`.cl-field-msg.error`); success in `--ok`. Focus is a soft halo, a 4 px outline of blue pencil at 18% that shows at once, with the field's edge firming to ink; buttons keep their 2 px ink ring.
12. **Hover needs a pointer.** Hover rules live inside `@media (hover: hover) and (pointer: fine)`.

## First run

- **Onboarding** (`screens/Onboarding.tsx`) is one step a screen, with no rail: Welcome (the cut shown on the stage, not footage faked), Account, the Anthropic key, your channel (its name and avatar, saved to the brand), and a few of your videos to learn from. Step dots at the top right; Back and the step's one primary at the foot. The account step is drawn but not wired, so it shows only in the browser mock until accounts exist. It runs once (`firstRun.ts`), decided when the launch check answers: someone already editing never sees it.
- **The setup card** sits at the foot of the open rail until every step is done (`setupSteps()`: the key, the channel's name, a first edit, one export). Each step left is a button to where it happens.
- **Start** shows the presets as pastel cards that show what they do (`PRESETS` in `Start.tsx`), then your projects on the stage, or, with none yet, sample shoots to try a first cut on.
- The rail is open by default where there is room (1100 px and up) and remembers how it was left.

## The crew

Cutalong runs separate jobs; each has a small character, so you watch a crew work for you instead of reading a progress bar. They live in `crew.ts`, names and all, so renaming one is one line:

| | Does | Colour | Shape |
|---|---|---|---|
| Echo | Sound: words, pauses, the beat, levels | blue | wave-edged |
| Snip | The cut: takes, pace, story | coral while cutting (coral is the cut), salmon at rest | star-cornered |
| Quill | Words on screen: captions, titles, descriptions | yellow | leaf |
| Scout | Finding things: bringing footage in, B-roll, pages | green | round, with an antenna |
| Tint | The look: colour, effects, graphics | pink | scalloped |
| Reel | Getting it out: clips, reframes, exports | lavender | pill |

- **Where they appear.** `Working` with `big`: the living mark leads, then each member a job has needed so far, the one at work saying what it is doing (`liveLine`) over one plain line, the ones before saying what they did (`doneLine`), then a thin progress line. The plain line is said once, under the last member at work, and each done mark sits beside its own line. A reply keeps its crew (`logCrew` in `push`/`patch`) and credits them in one quiet line when done (`Credits`, faces a little apart, never overlapping). A note says who picks it up (`memberForNote`), and those are the ones at work while notes are applied. The Crew page (`screens/Crew.tsx`) is a call sheet, not a grid of cards: a row per member on one sheet of paper, their face on a tile of their pastel, what they have learned from the brand (`crewLearned`) and what they need, with the steps. Before a member has learned anything their row says what they will learn (`willLearn`: "Snip will learn your pause length and your pace."); when no one has, the page says so once, under its lede, never in every row.
- **Rules.** One voice talks to you: Cutalong, in the first person; the crew never speaks in the chat. A member appears only for a stage the app really reports (`memberFor`); a stage no one owns brings no one in. Progress is real progress. They move only while working; idle is still.
- **Drawing one.** A shape from `shapes.ts` in their colour, with two eyes as small boxes of their own (`CrewFace`), so a blink is a transform. The face hops; its body (`.cl-crew-body`, the shape and eyes) does the work, so a member who starts again mid-hop finishes the hop while getting back to work.

## Components to reach for

- **Revision tabs** (`Revisions` in `Editor.tsx`): the newest versions as pastel tabs; the one on screen is ringed in ink and keeps the `cl-version` class, whose text is only `v{n}`. A version made while the editor is open wears a "new" sticker beside its tab.
- **The script** (`ScriptPanel`): numbered lines with a coverage line, an asterisk on every line the revision changed (`changedBeats()`), open notes pencilled in the margin.
- **The living mark** (`LivingMark`): three soft shapes in the bloom colours turning over a warm core. Big above long work; small in the assistant's tile while it thinks.
- **A brand's avatar** (`BrandAvatar`, `avatarOf(brand)`): the shape and colour picked on the Brand page (`AvatarPicker`), or one chosen from the brand's id until then. It shows in the brand's hero, the brand switch and the brand list.
- **Composer files**: round, glossy stills that float up into the composer (`.cl-attachment` with its `.cl-poster`).
- **Fields and steps for key setup**: `.cl-field` with `aria-invalid`, `.cl-field-msg` (`.error`, `.ok`), and `.cl-steps` (`.now` for the step that fixes what went wrong, `.done` for the ones a key Anthropic accepted shows are done). `KeySteps` draws any service's steps from `shared/setup`, and `ClaudeKeyField` is the Anthropic key's field: Start shows them until a key works (`KeySetup`), and Settings shows them while one does not.
- **Toasts** float at the top right under the header, on paper, and never cover the beat strip.

## Motion

Things float in and settle; what lands, lands on a spring with a hair of overshoot; only work in progress moves on its own. Styles are in `motion.css`, the few pieces that need script in `motion.tsx`, and every value is a token.

- **How fast.** `--duration-fast` 120 ms for hover, press, focus and leaving; `--duration-base` 180 ms for menus and toggles; `--duration-gentle` 260 ms for arrivals; `--duration-calm` 340 ms for screens and shared elements; `--duration-spring` 460 ms for a spring's whole run.
- **Which curve.** Arrive on `--ease-enter`. What lands (a card, a fact tile, footage dropped in, a crew member joining) lands on `--spring-settle` (4% overshoot); what pops (a sticker, a brand's new shape) on `--spring-pop` (6%). Leave on `--ease-exit`, shorter, and never bounce. The highlighter draws across its word (a `scale` on `.cl-accent::before`, 140 ms after the heading). Move between two places on `--ease-standard`. Loops that breathe (the living mark, a member at work) use `--ease-breathe`, the one curve that eases in.
- **What moves.** A reply rises 8 px and comes into focus from a 2 px blur, then its parts follow at 50, 90, 120 and 140 ms, its tiles at 60, 100 and 140 ms. Clip cards, preset cards, project stills and sample shoots overlap at 0, 45 and 80 ms. An onboarding step's parts rise at 0, 50, 90 and 120 ms and its side panel lands at 120 ms. A setup step done pops its tick on `--spring-pop`; the card's bar grows on `--spring-settle`. Dropped stills float up 24 px, 40 ms apart within each drop, while the composer opens to hold them as one box (a View Transition, "attach", and "detach" when the last one is taken out: its edge drawn on the moving group, one picture inside kept to the bottom edge where the words and buttons are); a second drop only floats its stills in, and under reduced motion the stills start part-visible since the composer makes room at once. A brand's avatar morphs by two pictures: the new shape pops in (from a 2 px softness) over the old, which holds for 90 ms, then softens and fades by 350 ms; picked again mid-way, what is fading keeps fading. Each crew member works in their own way (Echo breathes, Snip bounces at 748 ms each way, Quill sways, Scout looks about, Tint breathes slowly, Reel rolls), blinks now and then, and hops once when done. Anything that will count or tick holds its room from the start (the stopwatch is there, hidden, for its first second), so nothing shifts when it begins.
- **What appears at once.** Anything the keyboard opened. A list that arrives with its screen gets no second wave.
- **What never moves.** The footage, text being read, the layout (only transform, opacity and filter animate), anything idle, and coral.
- **Building it.** A new thing arriving takes an `@starting-style` transition in `motion.css`. Remove a row with `collapse()`, let something fall away with `useLingering()`, fill progress with `grow()`, change a screen with `viewTransition()`, and when something changes size in a way the layout would jump, give it a `viewTransition()` kind of its own (as the composer's "attach" and "detach") rather than animating height.
- **Reduced motion.** `--cl-travel` drops to 0: opacity still changes, nothing travels, scales, blurs or springs. The living mark only breathes in opacity; the crew only fades in and out.

## Voice

A helpful editor sitting next to you: first person, plain words, exact numbers. "v3 is ready. The hook word is bigger and the ending stays on you." The crew's lines are the stages the app reports, said plainly ("Echo is transcribing take-3.mov", "Snip read the footage"). No exclamation marks, no emoji, no praise, and never the word clone. Labels are verbs that say what happens. Seconds read as `0.15 s` (use `seconds()`), running times as `0:52` (use `clock()`).

## Where things are

- `App.tsx`: the rail and one screen at a time. `useCutalong.ts` holds the session.
- `components/`: `ui.tsx` (Mark, Button, IconButton, icons, AssistantAvatar), `Shapes.tsx` (Blob, Sticker, BrandAvatar, LivingMark), `Crew.tsx` (CrewFace, CrewAtWork, Credits), `Working`, `Composer`, `Message` (with `Facts`), `BeatStrip`, `Sidebar`, `ClipSet`, `BrandSwitch`.
- `screens/`: Onboarding, Start, Thread, Editor, Brand and BrandRules, Library, Crew, Settings and ClaudeFrames.
- `firstRun.ts`: whether onboarding ran, the first export, and the setup card's steps.
- `tokens.css` and `tokens.json`, `fonts.css` and `fonts/`, `revisions.ts`, `shapes.ts`, `crew.ts`, `facts.ts`, `working.ts`.
- `api.ts`: the slice of the preload API Cutalong uses. Add a method there and to `mock.ts` together.

## Checking a change

Heavy commands (typecheck, a full test run, a build, any app run) go through the shared lock: `flock /tmp/claude-0/-home-user-chop-shop/53b389d3-4ba3-5f34-8abd-cb88ea18110d/scratchpad/heavy.lock -c '<command>'`.

1. `npm run typecheck` and `npm test`.
2. `npx electron-vite build`, then serve `out/renderer`. In a plain browser `api.ts` uses the mock, so every screen can be reached.
3. Drive it with Playwright at 1440 x 900, 1280 x 840, 960 x 640 and a phone's 390 x 844, light and dark, and look at the screenshots. Catch the crew mid-job (three members), the reply's credits, the Crew page, and the Brand page's picker.
4. Run Hallmark's lint and Impeccable's detector live on each screen, and the impeccable finish and motion reviewers, and fix what they find.
5. Ask of every screenshot: is it heavenly and alive? Luminous, airy, colour you can feel around the footage, beautifully set, and moving only where work is happening.
