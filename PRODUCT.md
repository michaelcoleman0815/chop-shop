# Product

<!-- impeccable:product-schema 1 -->

Inferred from the repository (README.md, docs/rebuild.md, the cutalong-ui skill, the app's source) and the owner's
brief for the landing page, relayed by a coordinator. No interview with the owner took place; every line below is
inferred unless it quotes the brief, and the owner should confirm it.

## Platform

web

## Stack

The app: Electron, React and TypeScript (existing codebase). The marketing site in `site/`: delegated, built as plain
HTML, CSS and JavaScript with a zero-dependency Node build, deployed to Cloudflare Pages (root `site`, `npm run build`,
output `dist`).

## Users

YouTube creators on a Mac with Apple silicon who record themselves: talking-head videos, streams, Sunday services,
podcasts and days out for vlogs. They want a finished, upload-ready video without working a timeline by hand.

## Product Purpose

Cutalong is a desktop video editor people talk to. You drop footage, say what you want, and it edits; you refine by
chatting or in an editor with a preview, a beat strip and notes. Success is a creator going from raw footage to an
upload in one sitting, trusting what was cut and why.

## Positioning

Chat-first editing that cuts on the words, runs on the creator's own Mac and keeps every change as a named version they
can undo. The AI is Claude, through the creator's own Anthropic API key, so they pay Anthropic directly for what they use.

## Operating Context

Drop every file from a shoot; Cutalong sorts the talking, the better sound and the B-roll, lines the sound up, cuts
retakes and pauses. Plain-English asks and slash commands (`/shorts`, `/captions`, `/hook`, `/clipping`, `/vlog`,
`/premiere`, `/brand`) change the edit. Exports carry captions, a description with chapters, titles and tags.

## Capabilities and Constraints

- Ships today (each has a README entry): edits from raw footage; commands and plain-English asks; a stretch picked on the
  beat strip; length asks; blurred background fill; `/clipping`; vlogs; brands per channel with a never list and B-roll
  sources; the upload kit beside every export; export to Premiere.
- Being built, never to be presented as shipped: map documentaries; cinematic documentaries and animated explainers
  from a prompt; talking-head graphics and a 2×2 grid; the iPhone and Android app.
- Runs on macOS 14 Sonoma or later, Apple silicon only. Evidence: `electron-builder.yml` builds arm64 only; the v0.2.13
  release's Info.plist says 13.0, but its whisper-cli and Vision helper are built for 14.0, so transcription cannot
  start on 13.
- An Anthropic API key is required for plain-English asks; the app walks people through getting one. Slash commands,
  length cuts, transcription and rendering run on the Mac. A local model through Ollama can plan edits offline.
- Network use: Claude (the words and the edit; three small stills per vlog moment while "Let Claude see frames from my
  footage" is on, which it is by default), links the creator pastes and `/broll` searches (yt-dlp), the update check
  against GitHub Releases, the one-time transcription model download from Hugging Face, and optional services that only
  run with the creator's own keys (Deepgram and AssemblyAI hear the sound, Gemini sees short excerpts, Artlist music
  search). Keys are sealed with the macOS keychain. No analytics or telemetry.
- Undecided: Cutalong's own price. The domain is cutalong.io (cutalong.ai may become primary). Until a signed Cutalong
  release exists, the site offers no download: its buttons read "Get notified when it's ready" and lead to an email
  list that a Cloudflare Pages Function keeps in Workers KV (`downloadReady` in `site/site.config.mjs`).
  The app id and update feed still say chopshop on purpose; the latest public release (v0.2.13) is still named Chop Shop.

## Brand Commitments

The name is "cutalong" in lower case beside the mark: a solid ink bar (the take) above a dashed coral bar (the cut line),
offset right. Coral (#FF5A36) marks the cut and nothing else, which is why Snip, the crew member who cuts, is the only
coral one. The look is Lined Script (`docs/design/`): luminous paper, ink, revision tints, motion that floats and
settles, a calm night page in dark; the owner's notes add colour blocks, stickers, a living iridescent mark and headings
in bold Figtree with one italic Source Serif 4 accent. Figtree for reading, Source Serif 4 for what you read in the
product, JetBrains Mono for commands, timecode and file names. The crew (the owner's crew notes): Echo (sound), Snip
(the cut), Quill (words on screen), Scout (finds things), Tint (the look) and Reel (gets it out), each a small blob
drawn by code, shown only for work that really runs; their names are proposals, kept in `site/site.config.mjs` for the
site. Voice: first person for Cutalong, second person for the creator, never "we"; plain words,
exact numbers; no exclamation marks, emoji, praise, hype, or the word "clone". The published design system
(https://claude.ai/artifact/AsZpkLeXa7pLaqMZkipqLh) and `src/renderer/src/cutalong/tokens.json` are the source.

## Evidence on Hand

No testimonials, user counts, customer logos, ratings or press. No current screenshots: the app is being redesigned, and
the old captures in `docs/brand/` must not be used. Real visuals of the redesigned app arrive later, into slots. The
landing page's proof is the app's own planning code run on a test recording made for its checks (the numbers, the
struck lines and the reply), and the page says so under "How this was measured".

## Product Principles

1. Local first: footage, transcription and rendering stay on the creator's Mac.
2. The edit is data: every change is a named version, so nothing is lost.
3. Talk, don't configure: sentences and slash commands, numbers behind Details.
4. Pattern, not footage: a video someone likes is measured, never copied.

## Accessibility & Inclusion

WCAG 2.2 AA from the brief: contrast, visible focus, full keyboard use, and reduced motion respected.
