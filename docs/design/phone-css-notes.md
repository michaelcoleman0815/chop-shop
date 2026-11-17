# Lined Script and the phone build: what phone.css must change

The phone app shares the desktop components and `cutalong.css`, and lays itself out with `phone.css` under `.cl-app.phone` (on `claude/mobile`, not yet on `claude/mcp-x1yvms` when Lined Script landed). These are the changes it needs so the phone reads as the same paper, serif and revision pages. Read `.claude/skills/cutalong-ui/SKILL.md` first; it is the source for every rule here.

## Must change (things that break or look wrong)

1. **The version moved into revision tabs.** The header no longer has a bare `<span class="cl-version">` after the heading. It has `<div class="cl-revisions">` holding a `button.cl-rev-tab` for each recent version, and the one on screen also has `cl-version`. Rewrite:
   - `.cl-app.phone .cl-header .cl-heading:has(+ .cl-version)` as `.cl-app.phone .cl-header .cl-heading:has(+ .cl-revisions)`;
   - `.cl-app.phone .cl-header .cl-version + .spacer` as `.cl-app.phone .cl-header .cl-revisions + .spacer`.
   On a phone, show the tabs as a short scrolling row (`.cl-app.phone .cl-revisions { max-width: 44vw; }`), or only the forward tab (`.cl-app.phone .cl-rev-tab:not(.cl-version) { display: none; }`) when the header is tight.
2. **Colour literals.** Replace `rgba(21, 22, 26, 0.05)` (hover and pressed fills) with `color-mix(in oklch, var(--ink) 5%, transparent)`, `rgba(21, 22, 26, 0.18)` (the menu backdrop) with `color-mix(in oklch, var(--ink) 18%, transparent)`, and `0 18px 40px rgba(21, 22, 26, 0.1)` with `var(--shadow-float)`. Literals stay light in dark mode; the tokens follow the theme.
3. **Hover.** `cutalong.css` now puts every hover inside `@media (hover: hover) and (pointer: fine)`, so the phone's own hover resets (`.cl-app.phone .cl-rail-project:hover`, `.cl-app.phone .cl-btn.text:hover:not(:disabled)`, `.cl-app.phone .cl-chip:hover`, `.cl-app.phone .cl-icon-btn:hover:not(:disabled)`, `.cl-app.phone .cl-btn.primary:hover:not(:disabled)`) can go. Keep the `:active` press states.
4. **Toasts** now sit at the top right under the desktop header (`top: 84px; right: 24px`). On a phone, pin them full width under the phone's header: `.cl-app.phone ~ .cl-toast, .cl-app.phone .cl-toast { left: 12px; right: 12px; top: calc(env(safe-area-inset-top) + 64px); max-width: none; }` (the toast is rendered beside the app in `App.tsx`; match where it lands).
5. **The narrow-window rule** in `cutalong.css` (`@media (max-width: 1180px)`) floats the open rail over the screen on desktop. It is scoped to `.cl-app:not(.phone)`, so the phone's drawer is untouched; keep the `phone` class on `.cl-app`.

## Should change (to look like Lined Script)

6. **Replies in the serif.** `.cl-reply` is Source Serif 4 at 18/29 with a 36em measure. On a phone keep the face, set `.cl-app.phone .cl-reply { font-size: 17px; line-height: 27px; }`, and let the measure be the column.
7. **Your words** sit on `--well` with ink text (no longer an ink bubble). Nothing to do unless `phone.css` restyles `.cl-bubble`.
8. **The assistant's tile** is paper with the mark, and only the newest reply shows it. If `phone.css` hides or resizes `.cl-assistant-avatar`, keep it at 28 px and leave the visibility rule alone.
9. **Sheets** (`.cl-notes`, `.cl-strip`, `.cl-section`) carry `--shadow-page` and `--radius-card`. The phone's `border-radius: var(--radius-card) var(--radius-card) 0 0` bottom sheet is right; give it `box-shadow: var(--shadow-float)` so it floats over the preview.
10. **The script and notes.** In the editor's Script panel, lines are `.cl-sline` (number, coverage line, words, asterisk) with `.cl-margin-note` under them; notes are `.cl-note` rows with an italic serif text. At phone width, narrow the number column: `.cl-app.phone .cl-sline { grid-template-columns: 22px minmax(0, 1fr) 12px; column-gap: 8px; }`.
11. **Beats** wear the revision colour through `--rev`, set on `.cl-editor`. Do not set a beat background in `phone.css`.
12. **Dark mode** works through tokens alone: check every phone screen with the system in dark mode, and remove any fill that stays light.
13. **Fields** have a 3:1 edge (`--line-strong`) and inputs keep 16 px text so the page never zooms. The phone's `textarea` and note input sizes already follow that; keep them.

## Check

Build, open the phone layout at 390 x 844, light and dark, and compare with `docs/design/prototype/index.html` (Lined Script, Phone). Then run Hallmark's lint and Impeccable's detector on the phone screens, as the skill says.
