---
version: 2
slug: "site-src-index-html"
primary_target: "site/src/index.html"
related_targets: ["site/src/privacy.html","site/src/terms.html"]
---

## Scope

The Cutalong marketing site in `site/`: the landing page (`site/src/index.html`), Privacy and Terms drafts, and a 404.
Visitor mode: Persuade.

## Audience, job, action

YouTube creators on Apple silicon Macs who record talking heads, streams, services, podcasts and vlogs. The job is
"try"; until a signed release exists it is "get notified": one action, the email list. Proof is the product shown
working (the redesigned editor built in a slot until real captures arrive) and a real run of the app's own planning
code on a test recording, labelled as such. No testimonials, counts, logos or ratings exist; none are invented.

## Constraints

Brand pinned by Lined Script (`docs/design/`) and the owner's notes: luminous paper, ink, revision tints, a calm night
page in dark; colour blocks, stickers, a living iridescent mark, bold Figtree headings with one italic serif accent,
springs with a hair of overshoot; the crew (Echo, Snip, Quill, Scout, Tint, Reel) with the names and colours of the
crew notes, coral for Snip alone. Composite-only motion, an honest reduced-motion version, no heavy video on first
load. The voice rules (I and you, never we; no exclamation marks, emoji or praise). "Coming soon" items never read as
shipped. Cloudflare Pages: root `site`, `npm run build`, output `dist`. Domain, download link, form action and the
crew's names are config values. Until `downloadReady` is true, every download button reads "Get notified when it’s
ready" and leads to the email field; the list is a Pages Function and a KV namespace.

## Direction contract

THESIS: You talk; a crew does the work. The page shows the real product doing one real job, then introduces who did
it, then what else they do. It refuses the category default of a split hero over icon tiles, invented logos and
counts, and a closing email band that says nothing.

OWN-WORLD: Lined Script: paper that glows, ink type, revision pages (v2 on blue), the script with struck takes and
pencilled margin notes in serif, the beat strip with its coral playhead. The owner's notes add pastel colour blocks,
scalloped stickers, a living blob and the crew's characters.

STORY: In one screen a creator learns they can talk to an editor and watches it happen: the ask types, Echo finds the
pauses, Snip cuts it to length, the reply credits them, v2 lands on blue pages at 0:59, down from 1:39. Then the real
run (0:39, 10 struck, 0 cut by mistake), meet your crew, drop, say, refine, what you get as a bento, your Mac, straight
answers, and the email list.

FIRST VIEWPORT: Slab nav (lockup, six section links, "Get notified"). Centred: the living mark, the h1 "The video editor
you *talk to*", one sentence, the ink pill "Get notified when it’s ready" and one requirement line. Then the editor
window, wide, with its v2 sticker and time badge.

FORM: Custom (Hallmark direction: Script Page, alive). Signature: the crew at work on a clip inside the real editor.
Motion grammar: arrivals float up and settle on a spring; stickers and the crew pop; the living mark breathes; the hero
loop runs only after the visitor's first move, only while seen, and pauses on hover, focus or its button; idle is
still.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and
every shipping raster carrying its provenance.

## Memorable moment

Echo and Snip popping in beside the reply, doing their part, hopping once when done, and Snip landing on the strip as
it closes up.

## Unresolved

Cutalong's own price (a text slot in the FAQ). How the ready email is sent: the list is kept on Cloudflare, and a
mailing service, if one is used, has to be named in the Privacy draft. The crew's names (proposals). Real captures of
the redesigned app (slots: the hero loop, the three step screens, the five job screens).

## Review

Redesign round (the owner: "looks like crap"; then "heavenly and alive"; then the crew): references studied at 1440
and 390, critique and polish by Hallmark and Impeccable, review-animations and make-interfaces-feel-better passes. The
italic heading accent is the owner's and is kept against Hallmark's 38i.
