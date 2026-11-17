# The Cutalong site

The marketing site for Cutalong: a landing page, Privacy and Terms drafts, a 404, and the email list behind the
“Get notified” buttons. The pages are plain HTML, CSS and JavaScript, built by a small Node script with no
dependencies. The list is one Cloudflare Pages Function, `functions/api/signup.js`.

## Run it

```bash
cd site
npm run serve        # builds into dist/ and serves it at http://localhost:4321
```

`serve` behaves like Cloudflare Pages closely enough to test against: clean URLs, the rules in `_headers` (including
the content security policy) and `_redirects`, the 404 page, compressed text (so a local Lighthouse run measures what
ships), and the list's Function at `/api/signup`. The addresses
you send it are kept in memory and gone when it stops. For Cloudflare's own runtime, with a local store that persists:

```bash
npm run build && npx wrangler@4.156.2 pages dev dist --kv SIGNUPS
```

## Build it

```bash
npm run build        # writes dist/, the folder to deploy
npm run preview      # writes .preview/: a self-contained copy with relative .html links, to open or share anywhere
```

The build needs Node 22 or later (`.node-version` pins what Cloudflare uses). It fills the templates in `src/`, puts a
content hash in every asset's name, and writes `sitemap.xml`, `robots.txt`, `site.webmanifest`, `_headers` and
`_redirects` from the config. The preview has no Function, so its form says it is not connected.

## Where the config values are

Everything you might change is in [`site.config.mjs`](site.config.mjs):

| Value | What it does | Now |
| --- | --- | --- |
| `domain` | The main address. Every absolute URL comes from it: canonical links, Open Graph and Twitter cards, the sitemap, robots.txt. | `cutalong.io` |
| `downloadReady` | `false` until a signed Cutalong release exists. While it is false, every download button reads “Get notified when it’s ready” and leads to the email field, `/download` goes there too, and no page links to the releases. | `false` |
| `downloadUrl` | Where every “Download for Mac” goes once `downloadReady` is true, and where `/download` redirects then. | the latest GitHub release |
| `signupAction` | Where the email form posts. `/api/signup` is the list's Function. An `https://` address posts to an email provider instead. Empty means the form sends nothing and says so. | `/api/signup` |
| `signupField` | The field name the form sends the address as, and the one the Function reads (`email`, or what a provider expects). | `email` |
| `contactEmail` | The address in the footer, the legal drafts and the list's replies. | `hello@cutalong.io` |
| `owner` | The name in the footer and the legal drafts. | from `electron-builder.yml` |
| `requires` | What the current release needs, for the structured data. | macOS 14 or later, Apple silicon |
| `crew` | The crew's names and the one line each says for itself under “Meet your crew”. The hero's working rows and credit line use the names too. They are proposals: rename one here and every page follows. Keep each line to work the app really does. | Echo, Snip, Quill, Scout, Tint, Reel |

The form's `action` also feeds the content security policy's `form-action`, so a provider's address works without
editing headers.

When the release is ready, set `downloadReady: true` and deploy. The download buttons come back, and the form, its
reply and the Privacy draft switch from “when Cutalong is ready” to the list under Being built now. People who signed
up before were promised one email, when Cutalong is ready: send it, and ask before you write to them about anything
else.

## Deploy on Cloudflare Pages

The project is set up with:

- **Root directory:** `site`
- **Build command:** `npm run build` (Pages runs `npm install` first; there is nothing to install)
- **Build output directory:** `dist`
- **Production branch:** `claude/mcp-x1yvms`

`_headers` (security headers, long caching for hashed assets, and `noindex` on the `pages.dev` addresses) and
`_redirects` (`/download`) are written into `dist/` by the build. Pages serves `404.html` for unknown addresses, and
redirects `/privacy.html` to `/privacy`.

`functions/` sits at the project root, `site/functions`, beside `dist/` rather than in it, which is where Pages looks
for it. Pages builds it on every deploy and writes a `_routes.json` that sends only `/api/signup` to it, so every other
request stays a free static one. `_headers` does not reach a Function's replies, so the Function sets its own
(`Cache-Control: no-store` on every one). There is no Wrangler configuration file, on purpose: with one, Pages takes
its bindings from the file and ignores the dashboard.

### Domains

Add `cutalong.io` to the Pages project as its custom domain. `cutalong.net` and `cutalong.org` redirect to it with
Cloudflare redirect rules on their own zones, not with anything in this site:

| From | To | Status |
| --- | --- | --- |
| `cutalong.net/*` and `www.cutalong.net/*` | `https://cutalong.io/${1}` | 301 |
| `cutalong.org/*` and `www.cutalong.org/*` | `https://cutalong.io/${1}` | 301 |
| `www.cutalong.io/*` | `https://cutalong.io/${1}` | 301 |
| `cutalong.ai/*` and `www.cutalong.ai/*` (once owned) | `https://cutalong.io/${1}` | 301 |

Each domain has to be added to Cloudflare (as a zone, or as a custom domain on the project) before its rule or its
certificate works. The domains are registered at Squarespace, so their nameservers point at Cloudflare.

### Moving the main address to cutalong.ai

1. Change `domain` in `site.config.mjs` to `'cutalong.ai'` and deploy. Every absolute URL follows.
2. Add `cutalong.ai` to the Pages project as a custom domain.
3. Point the redirect rules at `https://cutalong.ai/${1}`, and add one for `cutalong.io/*` and `www.cutalong.io/*`.
4. Change `contactEmail` if the address moves too.

### Other hosts

`dist/` is plain static files, so the pages also deploy to Netlify, Vercel or GitHub Pages with the same build command
and output folder. Netlify reads the same `_headers` and `_redirects`; on Vercel or GitHub Pages, set the headers
there. The list's Function runs only on Cloudflare Pages: elsewhere, point `signupAction` at an email provider.

## The email list

The form posts to `/api/signup`, which keeps each address in the Workers KV namespace bound as `SIGNUPS`, with the time
it was left and where on the page it came from: `hero`, `header` or `close` for the button that led to the field,
`soon` for the field itself, `link` for someone who arrived at `/#signup` (where `/download` goes for now). Nothing
else is kept. It checks the address, ignores anything that fills in a hidden honeypot field (with the same reply, so a
bot cannot tell), answers in plain words, never repeats the address, and gives an address that is already on the list
the same reply as a new one. Without script, the form posts the ordinary way and the Function answers with a page.

### Connect it, once

1. **Create the namespace.** In the Cloudflare dashboard, go to **Workers KV** (under Storage & databases), select
   **Create instance**, name it `cutalong-signups`, and select **Create**. (Or run
   `npx wrangler@4.156.2 kv namespace create cutalong-signups`.)
2. **Bind it.** Go to **Workers & Pages**, select the Pages project, then **Settings → Bindings → Add → KV namespace**.
   Set **Variable name** to `SIGNUPS` and **KV namespace** to `cutalong-signups`, and save. That is the Production
   environment. For Preview, either bind a second namespace (`cutalong-signups-preview`) so test addresses stay out of
   the real list, or leave it unbound: the form on a preview then says the list is not connected.
3. **Redeploy.** A binding takes effect from the next deployment: push a commit to the production branch, or on the
   project's **Deployments** page open the menu (⋯) beside the latest production deployment and choose **Retry
   deployment**.
4. **Try it.** Leave your own address on https://cutalong.io, find it under the namespace's **KV Pairs**, and delete it.

Until step 3, the form answers “The list isn’t connected yet, so nothing was saved” and gives the contact address.

### Export it

```bash
cd site
npx wrangler@4.156.2 login                        # once, in a browser
npx wrangler@4.156.2 kv namespace list            # copy the id of cutalong-signups
npx wrangler@4.156.2 kv key list --namespace-id <id> --remote > signups.json
node -e 'for (const k of require("./signups.json")) console.log([k.name, k.metadata.at, k.metadata.source].join(","))' > signups.csv
```

Each key is an address; its metadata holds the time (`at`) and `source`. `--remote` matters: without it, Wrangler 4
lists a local copy. `signups.json` and `signups.csv` are ignored by git; keep them off shared drives.

To remove an address on request, delete it under **KV Pairs**, or run
`npx wrangler@4.156.2 kv key delete --namespace-id <id> --remote "name@example.com"`. Addresses are stored in lower case.

If you send the ready email through a mailing service, importing the list gives that service the addresses: name it in
the Privacy draft first.

## Real visuals

The app is being redesigned, so the page shows HTML stand-ins of the app inside slots. Each slot is an element with
`data-slot`; drop an image or video into it, or call `hallmarkSlots({ name: 'file' })`, and the stand-in steps aside
without moving the layout. The hero’s pause button stays, and works for a video. The loop starts at the visitor’s
first scroll, pointer move, touch or key, so a page left alone (and Lighthouse) sees its last frame, still.

| Slot | What belongs there | Size |
| --- | --- | --- |
| `hero-loop` | A 10 to 20 second loop of the redesigned editor: a request typed, the crew at work, the new version on its coloured pages | 2400 × 1240 |
| `step-drop`, `step-say`, `step-refine` | The three steps: a drop being sorted, the composer with the slash menu, a picked stretch with a note | 1200 × 900 |
| `job-raw`, `job-clips`, `job-vlog`, `job-brand`, `job-upload` | The editor with a command, the clips `/clipping` found, a vlog's story, the Brand page, the files beside an export | 2400 × 1500 |

Keep a loop under 2 MB (H.264 MP4, or WebM), muted, with a poster frame. The hero's stickers, its time badge and
Snip on the strip sit outside the slot, so they stay over a capture; take them out of `src/index.html` if the capture
shows the same thing.

## Shapes, the crew and the fonts

`npm run shapes` redraws everything on the page that is drawn by code rather than kept as a picture: the living mark
(`src/img/living-a.svg` and `living-b.svg`, a soft blob in two layers that turn against each other), the scalloped
sticker edge, the three brand-avatar shapes, and the crew, one SVG partial each in `src/partials/crew-*.html`. The crew
take their colours from the page (`--crew-*` in `src/css/tokens.css`): the revision pastels, with coral for Snip alone,
because coral is the cut. Their names come from `crew` in the config, never from the partials.

The faces are Figtree (headings and everything you read on the page), Source Serif 4 (what you read in the product,
and one italic accent in a heading) and JetBrains Mono (timecode and file names), all self-hosted. Source Serif 4 is
three subsets of the variable font, cut to Latin with fonttools at fixed optical sizes: text roman and italic, and the
display italic at weight 440 for the accents. `src/fonts/SourceSerif4-OFL.txt` is its licence.

## Images, checks and tests

```bash
npm run images       # redraws the favicons, app icons and social cards from the mark (needs Playwright)
npm run shapes       # redraws the living mark, the sticker edge, the avatar shapes and the crew
npm run check        # screenshots at 1440, 1024, 768 and 390, light and dark, and a keyboard pass (needs Playwright)
npm test             # the list's Function: valid, invalid, missing, honeypot, a KV failure, with a fake KV
npm run test:e2e     # the form against the real Function under wrangler pages dev (needs Playwright; runs Wrangler with npx)
```

`check` and `test:e2e` find Playwright in `site/node_modules` or a global install (`npm i --no-save playwright`), and
Chrome through `CHROME_PATH`. `test:e2e` uses a throwaway store under `.wrangler/`, or a Wrangler you name with
`WRANGLER=/path/to/wrangler`.

## The legal drafts

`src/privacy.html` and `src/terms.html` are drafts, marked as drafts on the page, for the owner to review with a lawyer.
They are not legal advice. They describe what the app does today (local processing, keys sealed in the keychain, the
services it calls only with your keys, the update check against GitHub Releases, the one-time transcription model
download) and the email list (kept on Cloudflare, used only to say when Cutalong is ready, removed on request). Their
dashed blanks are decisions still open: the date they take effect, Cutalong’s price, a liability cap and the governing
law.
