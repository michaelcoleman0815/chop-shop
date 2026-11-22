// The few pieces of the page that need script. Everything reads and works without it.

const reduce = matchMedia('(prefers-reduced-motion: reduce)')

// ---- The hero's take: the real v2, playing without sound while it can be seen. Sound is one press away;
// with reduced motion it waits, with the player's own controls, until it is played.
document.querySelectorAll('[data-take]').forEach((video) => {
  const sound = video.parentElement.querySelector('[data-take-sound]')
  const label = sound?.querySelector('[data-take-sound-label]')
  const still = () => reduce.matches
  let seen = false
  const sync = () => {
    video.controls = still()
    if (sound) sound.hidden = still()
    if (still()) return
    if (seen) video.play().catch(() => {})
    else video.pause()
  }
  sound?.addEventListener('click', () => {
    video.muted = !video.muted
    if (!video.muted) video.play().catch(() => {})
    sound.setAttribute('aria-pressed', String(!video.muted))
    if (label) label.textContent = video.muted ? 'Sound on' : 'Sound off'
  })
  new IntersectionObserver(([entry]) => {
    seen = entry.isIntersecting
    sync()
  }, { threshold: 0.35 }).observe(video)
  reduce.addEventListener('change', sync)
  sync()
})

// ---- The download: the one for the visitor's computer, or a plain answer when Cutalong doesn't run there yet.
// Without script every button is "Download for Mac" to the releases page. With it, a Mac gets the .dmg itself
// and a Windows PC the installer, once the latest release carries one; a phone can send the link to its
// computer; Linux, a Chromebook and an Intel Mac hear where it runs.
const getBoxes = document.querySelectorAll('[data-get-box]')
const getLinks = document.querySelectorAll('a[data-get]')
if (getLinks.length) {
  const releases = document.querySelector('[data-releases]')?.dataset.releases || getLinks[0].href
  const ua = navigator.userAgent
  const touch = navigator.maxTouchPoints > 1

  // Apple silicon or Intel, where the browser will say: Chrome by its architecture hint, others by the graphics
  // chip's name. Safari says only "Apple GPU" either way, so that one stays unknown.
  const appleSilicon = async () => {
    try {
      const hints = await navigator.userAgentData?.getHighEntropyValues?.(['architecture'])
      if (hints?.architecture) return hints.architecture === 'arm'
    } catch {}
    try {
      const gl = document.createElement('canvas').getContext('webgl')
      const info = gl?.getExtension('WEBGL_debug_renderer_info')
      const chip = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : ''
      if (/Apple M\d/i.test(chip)) return true
      if (/Intel|AMD|Radeon|NVIDIA/i.test(chip)) return false
    } catch {}
    return null
  }

  const deviceOf = async () => {
    if (/iPhone|iPod/.test(ua)) return 'iphone'
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch)) return 'ipad'
    if (/Android/.test(ua)) return 'android'
    if (/CrOS/.test(ua)) return 'chromebook'
    if (/Windows/.test(ua)) return 'windows'
    if (/Macintosh|Mac OS X/.test(ua)) return (await appleSilicon()) === false ? 'intel-mac' : 'mac'
    if (/Linux|X11/.test(ua)) return 'linux'
    return 'other'
  }

  // The latest release, straight from GitHub, so the download is one click instead of a list of files.
  const latestRelease = async () => {
    const repo = /github\.com\/([^/]+\/[^/]+)/.exec(releases)?.[1]
    if (!repo) return null
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
      return r.ok ? await r.json() : null
    } catch {
      return null
    }
  }
  /** The release's file for this computer: the Apple silicon .dmg, or the Windows installer (not its blockmap). */
  const fileFor = (release, device) => {
    const assets = release?.assets ?? []
    const pick = device === 'windows'
      ? assets.find((a) => /setup.*x64\.exe$/i.test(a.name)) || assets.find((a) => /\.exe$/i.test(a.name))
      : assets.find((a) => /arm64\.dmg$/i.test(a.name)) || assets.find((a) => /\.dmg$/i.test(a.name))
    return pick ? { url: pick.browser_download_url, version: String(release.tag_name || '').replace(/^v/, ''), mb: Math.round(pick.size / 1e6) } : null
  }
  // Unsigned, Windows asks before the first run: the page says what to press (site.config.mjs windowsSigned).
  const winSigned = document.querySelector('[data-win-signed]')?.dataset.winSigned === 'true'

  const NAMES = { iphone: 'iPhone', ipad: 'iPad', android: 'Android', windows: 'Windows', linux: 'Linux', chromebook: 'Chromebook' }
  const site = location.origin + '/download'

  const setNote = (box, text) => {
    const note = box.querySelector('[data-get-note]')
    if (note) note.textContent = text
  }
  const showAlso = (box) => {
    const also = box.querySelector('[data-get-also]')
    if (also) also.hidden = false
  }

  /** The buttons and notes for a computer it runs on, from a release; false when this computer isn't one of those. */
  const offer = (device, release) => {
    const exe = device === 'windows' ? fileFor(release, 'windows') : null
    if (exe) {
      // A Windows PC, and a release that has its installer.
      getLinks.forEach((a) => {
        a.href = exe.url
        a.textContent = a.dataset.get === 'long' ? 'Download for Windows' : 'Download'
      })
      getBoxes.forEach((box) =>
        setNote(box, `Version ${exe.version}, ${exe.mb} MB. For Windows 10 and 11, 64-bit.${winSigned ? '' : ' Windows may ask before it first opens: choose More info, then Run anyway.'}`)
      )
      return true
    }
    if (device === 'mac' || device === 'intel-mac' || device === 'other') {
      const dmg = fileFor(release, 'mac')
      if (dmg) getLinks.forEach((a) => (a.href = dmg.url))
      document.querySelectorAll('[data-get-also]').forEach((a) => dmg && (a.href = dmg.url))
      const facts = dmg ? `Version ${dmg.version}, ${dmg.mb} MB. ` : ''
      getBoxes.forEach((box) =>
        setNote(box, device === 'intel-mac'
          ? 'This Mac looks like it has an Intel chip. Cutalong needs a Mac with Apple silicon (M1 or later), on macOS 14 or later.'
          : `${facts}For Macs with Apple silicon, on macOS 14 or later.`)
      )
      return true
    }
    return false
  }

  // A tab left open keeps the release it was opened with, so a release out since then would never reach it, and a
  // visitor who comes back hours later downloads an old version. The page asks GitHub again when the tab is come
  // back to, and before a download from a lookup more than five minutes old. When GitHub doesn't answer, the
  // buttons keep what they have and the page doesn't ask again for another five minutes.
  const STALE_MS = 5 * 60 * 1000
  const LOOKUP_WAIT_MS = 4000
  let lookedAt = 0
  let asking = null
  const stale = () => Date.now() - lookedAt >= STALE_MS
  const freshen = (device) => {
    if (!stale()) return Promise.resolve()
    asking ??= latestRelease()
      .then((release) => {
        lookedAt = Date.now()
        if (release) offer(device, release)
      })
      .finally(() => (asking = null))
    return asking
  }
  const keepFresh = (device) => {
    const check = () => document.visibilityState === 'visible' && freshen(device)
    document.addEventListener('visibilitychange', check)
    addEventListener('focus', check)
    addEventListener('pageshow', (e) => e.persisted && check())
    document.querySelectorAll('a[data-get], a[data-get-also]').forEach((a) =>
      a.addEventListener('click', (e) => {
        // A plain click on an old lookup waits for a fresh one, at most a few seconds, then downloads what it says.
        if (!stale() || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        Promise.race([freshen(device), new Promise((done) => setTimeout(done, LOOKUP_WAIT_MS))]).then(() =>
          location.assign(a.href)
        )
      })
    )
  }

  deviceOf().then(async (device) => {
    document.documentElement.dataset.device = device
    const release = device === 'iphone' || device === 'ipad' || device === 'android' ? null : await latestRelease()
    lookedAt = Date.now()
    if (offer(device, release)) return keepFresh(device)
    const phone = device === 'iphone' || device === 'ipad' || device === 'android'
    getLinks.forEach((a) => {
      const long = a.dataset.get === 'long'
      if (phone && navigator.share) {
        // On a phone the useful thing is the link on the Mac: the share sheet sends it there (AirDrop, Messages, mail).
        a.textContent = long ? 'Send the download to your Mac' : 'Send to Mac'
        a.addEventListener('click', (e) => {
          e.preventDefault()
          navigator.share({ title: 'Cutalong for Mac', url: site }).catch(() => {})
        })
      } else {
        a.textContent = long ? `Tell me when it’s on ${NAMES[device] || 'my computer'}` : 'Get notified'
        a.href = '#signup'
        a.dataset.notify = device
      }
    })
    getBoxes.forEach((box) => {
      setNote(box, phone
        ? `Cutalong runs on a Mac. The ${NAMES[device]} app is on its way: leave your email below to hear when.`
        : device === 'windows'
          ? 'The Windows version is on its way: leave your email below to hear when it is ready.'
          : `Cutalong runs on a Mac${release && fileFor(release, 'windows') ? ' and on Windows' : ''} for now, so there is nothing to download for ${NAMES[device] || 'this computer'} yet.`)
      showAlso(box)
    })
  })
}

// ---- The header takes a hairline once the page has moved under it.
const slab = document.querySelector('.slab')
if (slab) {
  const mark = () => slab.classList.toggle('is-scrolled', scrollY > 8)
  addEventListener('scroll', mark, { passive: true })
  mark()
}

// ---- The living mark breathes only while it can be seen.
if ('IntersectionObserver' in window) {
  document.querySelectorAll('[data-living]').forEach((el) =>
    new IntersectionObserver(([entry]) => el.classList.toggle('is-asleep', !entry.isIntersecting)).observe(el)
  )
}

// ---- Arrivals: each part floats up and settles once, as it comes into view. With less motion the CSS shows it as it is.
const reveals = document.querySelectorAll('.reveal')
if (reveals.length && 'IntersectionObserver' in window) {
  const seen = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.classList.add('is-in')
        seen.unobserve(entry.target)
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.12 }
  )
  reveals.forEach((el) => seen.observe(el))
} else reveals.forEach((el) => el.classList.add('is-in'))

// ---- The email list. Wired to the list's Function (functions/api/signup.js), it posts there and shows the reply;
// without script it posts the ordinary way and the Function answers with a page. Unwired, it sends nothing and says so.
document.querySelectorAll('form[data-signup]').forEach((form) => {
  const input = form.querySelector('input[type="email"]')
  const help = form.querySelector('[data-signup-help]')
  const submit = form.querySelector('button[type="submit"]')
  const source = form.querySelector('[data-signup-source]')
  const wired = form.dataset.signup === 'ready'
  const rest = help.textContent
  let busy = false
  const say = (text, state = '') => {
    help.textContent = text
    if (state) form.dataset.state = state
    else delete form.dataset.state
  }
  const wrong = (text) => {
    input.setAttribute('aria-invalid', 'true')
    say(text, 'error')
    input.focus()
  }
  submit.disabled = false

  // Each "Get notified" button leads to the field, and the list keeps which one it was.
  // The link's own jump does the scrolling; focusing here, inside the tap, is what brings up a phone's keyboard.
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[data-notify]')
    if (!a) return
    if (source) source.value = a.dataset.notify
    input.focus({ preventScroll: true })
  })
  if (source && location.hash === '#signup') source.value = 'link'

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (busy) return
    if (input.validity.valueMissing) return wrong('Write your email address first.')
    if (!input.checkValidity()) return wrong('That address looks incomplete. Write it as name@example.com.')
    if (!wired) return say('Nothing was sent: this list is not connected yet.')
    busy = true
    form.setAttribute('aria-busy', 'true')
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: new URLSearchParams(new FormData(form))
      })
      const reply = await response.json().catch(() => ({}))
      if (reply.ok) {
        input.value = ''
        input.removeAttribute('aria-invalid')
        say(reply.message, 'done')
      } else if (reply.error === 'missing' || reply.error === 'invalid') {
        wrong(reply.message)
      } else {
        say(reply.message || 'The list couldn’t take that just now. Try again in a minute.', 'error')
      }
    } catch {
      say('The list couldn’t be reached. Check your connection and try again.', 'error')
    } finally {
      busy = false
      form.removeAttribute('aria-busy')
    }
  })
  input.addEventListener('input', () => {
    if (input.hasAttribute('aria-invalid') && input.checkValidity()) {
      input.removeAttribute('aria-invalid')
      say(rest)
    }
  })
})

// ---- Slots: real captures replace the built stand-ins without touching the layout (Hallmark).
// hallmarkSlots({ 'hero-loop': 'media/hero.mp4' }) or { 'step-drop': { src: 'media/drop.png', alt: '...' } }
window.hallmarkSlots = (map) => {
  for (const [name, value] of Object.entries(map)) {
    const slot = document.querySelector(`[data-slot="${name}"]`)
    if (!slot) continue
    const src = typeof value === 'string' ? value : value.src
    const media = /\.(mp4|webm|mov)$/i.test(src) ? Object.assign(document.createElement('video'), { muted: true, loop: true, playsInline: true, autoplay: !reduce.matches }) : new Image()
    media.src = src
    if (media instanceof HTMLImageElement) media.alt = (typeof value === 'object' && value.alt) || slot.dataset.alt || ''
    slot.querySelectorAll(':scope > img, :scope > video').forEach((old) => old.remove())
    slot.prepend(media)
  }
}
document.querySelectorAll('[data-slot] img').forEach((img) => {
  if (img.complete && !img.naturalWidth) img.remove()
  else img.addEventListener('error', () => img.remove(), { once: true })
})
