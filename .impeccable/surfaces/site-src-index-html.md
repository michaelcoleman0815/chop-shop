---
version: 1
slug: "site-src-index-html"
primary_target: "site/src/index.html"
related_targets: ["site/src/privacy.html","site/src/terms.html"]
---

## Scope

The Cutalong marketing site in `site/`: the landing page (`site/src/index.html`), Privacy and Terms drafts, and a 404.
Visitor mode: Persuade.

## Audience, job, action

YouTube creators on Apple silicon Macs who record talking heads, streams, services, podcasts and vlogs. The job is
"try": download the Mac app. Proof is the product shown working (HTML stand-ins until real captures of the redesigned
app arrive) and plain facts about what runs where. No testimonials, counts, logos or ratings exist; none are invented.

## Constraints

Brand pinned by the Cutalong design system: coral for the cut only, ink primary, Figtree and JetBrains Mono, the voice
rules (I and you, never we; no exclamation marks, emoji or praise). "Coming soon" items never read as shipped.
Cloudflare Pages: root `site`, `npm run build`, output `dist`. Domain, download link and form action are config values.
Until a signed Cutalong release exists (`downloadReady: false`), every download button reads "Get notified when it’s
ready" and leads to the email field; the list is a Pages Function (`site/functions/api/signup.js`) and a KV namespace.

## Direction contract

THESIS: The page is one edit, played top to bottom. The editor's own beat strip rides in the slab nav as the page's
navigation, the coral playhead marking where you are, and every section is a beat that shows Cutalong cutting. It
refuses the category default: a split hero over icon tiles, three numbered cards and a closing email band.

OWN-WORLD: Cutalong's system unchanged: warm grey ground, white cards on one hairline, ink type and ink pill buttons,
Figtree set bold and tight for display, JetBrains Mono only for commands, timecode and file names, coral only on the
mark, the playhead and the assistant avatar. Product renderings stay the app's light palette in both page modes.

STORY: In one screen a creator learns they can talk to an editor and sees a raw recording become v2. Then: footage stays
on the Mac and the key is their own; drop, say, refine; their own job among five; straight answers; download (until
the release, the email list).

FIRST VIEWPORT: Slab nav: lockup left, the page's beat strip in the middle, a quiet pill right ("Get notified" until the
release, then "Download"). The h1 "The video editor you talk to" on one line across twelve columns at display size;
under it the lede left and the ink pill right ("Get notified when it’s ready", then "Download for Mac") with one
requirement line. Then a twelve-column plate (the hero-loop slot): the thread,
where the creator's ink bubble asks for a cut and v2 lands, beside the script view, where the retakes and a pause are
struck through as the beat strip closes from 31:40 to 9:58. It loops with a pause control.

FORM: The cut-line spine, position 5 of 7 on the ranked list, seed:4540dfcca026596a. Signature interaction: the beat
strip in the nav, one beat per section, the coral playhead tracking the scroll, a beat jumping to its section. Motion
grammar: arrivals on the brand's ease-enter at 240 ms with a small rise, the nav playhead tracking the scroll one to one,
the switcher's pill on spring-gentle, nothing idle moving except the demo loop and the playhead.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Memorable moment

The nav's beat strip filling in as you scroll, with the coral playhead on your place.

## Unresolved

Cutalong's own price (a text slot in the FAQ). How the ready email is sent: the list is kept on Cloudflare, and a
mailing service, if one is used, has to be named in the Privacy draft.
Real captures of the redesigned app (slots: the hero loop, the three step screens, the five job screens).

## Review

Hero review (in-thread, no subagent available): fix, one finding, resolved (the empty preview frame became the script
view with its struck lines). Finish review (in-thread): fix, one finding resolved (the job copy rows), then ship.
