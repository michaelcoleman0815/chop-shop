# The Cutalong site

The marketing site for Cutalong: a landing page, Privacy and Terms drafts, and a 404. Plain HTML, CSS and JavaScript,
built by a small Node script with no dependencies, so it deploys to any static host.

## Run it

```bash
cd site
npm run serve        # builds into dist/ and serves it at http://localhost:4321
```

`serve` behaves like Cloudflare Pages closely enough to test against: clean URLs, the rules in `_headers` (including
the content security policy) and `_redirects`, and the 404 page.

## Build it

```bash
npm run build        # writes dist/, the folder to deploy
npm run preview      # writes .preview/: a self-contained copy with relative .html links, to open or share anywhere
```

The build needs Node 20 or later (`.node-version` pins what Cloudflare uses). It fills the templates in `src/`, puts a
content hash in every asset's name, and writes `sitemap.xml`, `robots.txt`, `site.webmanifest`, `_headers` and
`_redirects` from the config.

## Where the config values are

Everything you might change is in [`site.config.mjs`](site.config.mjs):

| Value | What it does | Now |
| --- | --- | --- |
| `domain` | The main address. Every absolute URL comes from it: canonical links, Open Graph and Twitter cards, the sitemap, robots.txt. | `cutalong.io` |
| `downloadUrl` | Where every “Download for Mac” goes, and where `/download` redirects. | the latest GitHub release |
| `signupAction` | Where the coming-soon email form posts. Empty means the form sends nothing and says so. | empty |
| `signupField` | The field name your email provider expects (`email`, `EMAIL`, `email_address`). | `email` |
| `contactEmail` | The address in the footer and the legal drafts. | `hello@cutalong.io` |
| `owner` | The name in the footer and the legal drafts. | from `electron-builder.yml` |
| `requires` | What the current release needs, for the structured data. | macOS 14 or later, Apple silicon |

The form's `action` also feeds the content security policy's `form-action`, so a new provider works without editing
headers.

## Deploy on Cloudflare Pages

The project is set up with:

- **Root directory:** `site`
- **Build command:** `npm run build` (Pages runs `npm install` first; there is nothing to install)
- **Build output directory:** `dist`
- **Production branch:** `claude/mcp-x1yvms`

`_headers` (security headers, long caching for hashed assets, and `noindex` on the `pages.dev` addresses) and
`_redirects` (`/download`) are written into `dist/` by the build. Pages serves `404.html` for unknown addresses, and
redirects `/privacy.html` to `/privacy`.

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

`dist/` is plain static files, so it also deploys to Netlify, Vercel or GitHub Pages with the same build command and
output folder. Netlify reads the same `_headers` and `_redirects`; on Vercel or GitHub Pages, set the headers there.

## Real visuals

The app is being redesigned, so the page shows HTML stand-ins of the app inside slots. Each slot is an element with
`data-slot`; drop an image or video into it, or call `hallmarkSlots({ name: 'file' })`, and the stand-in steps aside
without moving the layout. The hero’s pause button stays, and works for a video. The loop starts at the visitor’s
first scroll, pointer move, touch or key, so a page left alone (and Lighthouse) sees its last frame, still.

| Slot | What belongs there | Size |
| --- | --- | --- |
| `hero-loop` | A 10 to 20 second loop: footage dropped in, a request, the new version in the editor | 2400 × 1000 |
| `step-drop`, `step-say`, `step-refine` | The three steps: a drop being sorted, the composer with the slash menu, a picked stretch with a note | 1200 × 900 |
| `job-raw`, `job-clips`, `job-vlog`, `job-brand`, `job-upload` | The editor with a command, the clips `/clipping` found, a vlog's story, the Brand page, the files beside an export | 2400 × 1000 |
| `start` | The app's first screen | 1400 × 1000 |

Keep a loop under 2 MB (H.264 MP4, or WebM), muted, with a poster frame.

## Images and checks

```bash
npm run images       # redraws the favicons, app icons and social cards from the mark (needs Playwright)
npm run check        # screenshots at 1440, 1024, 768 and 390, light and dark, and a keyboard pass (needs Playwright)
```

Both find Playwright in `site/node_modules` or a global install (`npm i --no-save playwright`), and Chrome through
`CHROME_PATH`.

## The legal drafts

`src/privacy.html` and `src/terms.html` are drafts, marked as drafts on the page, for the owner to review with a lawyer.
They are not legal advice. They describe what the app does today (local processing, keys sealed in the keychain, the
services it calls only with your keys, the update check against GitHub Releases, the one-time transcription model
download). Their dashed blanks are decisions still open: the date they take effect, Cutalong’s price, the email
provider, a liability cap and the governing law.
