// The site's facts, in one place. The build reads this file and nothing else for them, and the email
// list's Function (functions/api/signup.js) reads it too.
//
// Every absolute URL on the site (the canonical links, Open Graph and Twitter cards, the sitemap and
// robots.txt) is built from `domain`. When cutalong.ai becomes the main address, change `domain` to
// 'cutalong.ai' and redeploy; the Cloudflare redirect rules in README.md list what else changes.

export default {
  // The main address, without https:// or a trailing slash.
  domain: 'cutalong.io',

  // false until a signed Cutalong release exists. While it is false, every download button reads
  // "Get notified when it's ready" and leads to the email field, /download goes there too, and no
  // page links to the releases. true brings the download buttons back, pointing at `downloadUrl`.
  downloadReady: false,

  // Where every "Download for Mac" button goes once `downloadReady` is true, and where
  // cutalong.io/download redirects then (see _redirects in the build). For now, the latest GitHub release.
  downloadUrl: 'https://github.com/michaelcoleman0815/chop-shop/releases/latest',

  // Where the email form posts. '/api/signup' is the Pages Function in functions/api/signup.js, which
  // keeps each address in the KV namespace bound as SIGNUPS (README.md has the steps). An https://
  // address posts to an email provider instead, with `signupField` as the field name it expects.
  // Empty means the form sends nothing and says so.
  signupAction: '/api/signup',
  signupField: 'email',

  // The address for questions, printed in the footer, the legal drafts and the list's replies.
  contactEmail: 'hello@cutalong.io',

  // Who publishes the site and the app, for the footer and the legal drafts.
  // Taken from the copyright line in electron-builder.yml.
  owner: 'Michael Coleman',

  // What the current release needs. electron-builder builds arm64 only; the shipped whisper-cli and
  // Vision helper are built for macOS 14, so transcription cannot start on anything older.
  requires: 'macOS 14 Sonoma or later, on a Mac with Apple silicon',

  // The crew: one small character per real job, with the names and colours the app uses (the owner's crew notes).
  // The names are proposals the owner can change here; the page reads them from nowhere else.
  // `line` is what each says for itself in "Meet your crew"; keep it to work the app really does.
  crew: {
    echo: { name: 'Echo', line: 'I write down every word, and hear the pauses and the beat.' },
    snip: { name: 'Snip', line: 'I cut the retakes and the slack, to the length you ask for.' },
    quill: { name: 'Quill', line: 'I write the captions, the titles, the chapters and the description.' },
    scout: { name: 'Scout', line: 'I find the B-roll, the music and the sound effects.' },
    tint: { name: 'Tint', line: 'I set the look: colour, effects, graphics and motion.' },
    reel: { name: 'Reel', line: 'I get it out: Shorts, clips, vertical crops and the upload kit.' }
  }
}
