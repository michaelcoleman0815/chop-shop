// The site's facts, in one place. The build reads this file and nothing else for them.
//
// Every absolute URL on the site (the canonical links, Open Graph and Twitter cards, the sitemap and
// robots.txt) is built from `domain`. When cutalong.ai becomes the main address, change `domain` to
// 'cutalong.ai' and redeploy; the Cloudflare redirect rules in README.md list what else changes.

export default {
  // The main address, without https:// or a trailing slash.
  domain: 'cutalong.io',

  // Where every "Download for Mac" button goes. For now, the latest GitHub release.
  // cutalong.io/download redirects here too (see _redirects in the build).
  downloadUrl: 'https://github.com/michaelcoleman0815/chop-shop/releases/latest',

  // Where the coming-soon email form posts. Leave it empty until an email provider is chosen:
  // the form then sends nothing and says so. `signupField` is the field name the provider expects.
  signupAction: '',
  signupField: 'email',

  // The address for questions, printed in the footer and the legal drafts.
  contactEmail: 'hello@cutalong.io',

  // Who publishes the site and the app, for the footer and the legal drafts.
  // Taken from the copyright line in electron-builder.yml.
  owner: 'Michael Coleman',

  // What the current release needs. electron-builder builds arm64 only; the shipped whisper-cli and
  // Vision helper are built for macOS 14, so transcription cannot start on anything older.
  requires: 'macOS 14 Sonoma or later, on a Mac with Apple silicon'
}
