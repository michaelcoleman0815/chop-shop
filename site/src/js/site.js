// The few pieces of the page that need script. Everything reads and works without it.

const reduce = matchMedia('(prefers-reduced-motion: reduce)')

// ---- The hero's loop: it runs only while seen, stops on hover, focus or the button, and never under reduced motion.
// It starts at its own end (the state the page shows without script), so nothing jumps when it takes over.
document.querySelectorAll('[data-loop]').forEach((el) => {
  const button = el.querySelector('[data-loop-toggle]')
  const label = el.querySelector('[data-loop-label]')
  // It waits for the visitor's first scroll, pointer move, touch or key, so a page left alone stays still and readable.
  const state = { seen: false, engaged: false, hover: false, focus: false, held: false }
  const sync = () => {
    if (reduce.matches) {
      el.classList.remove('is-live', 'is-running')
      return
    }
    if (state.seen && state.engaged) el.classList.add('is-live')
    const run = state.seen && state.engaged && !state.hover && !state.focus && !state.held
    el.classList.toggle('is-running', run)
    el.querySelectorAll('video').forEach((v) => (run ? v.play().catch(() => {}) : v.pause()))
    if (button) {
      button.toggleAttribute('data-held', state.held)
      if (label) label.textContent = state.held ? 'Play' : 'Pause'
      button.setAttribute('aria-label', state.held ? 'Play the example' : 'Pause the example')
    }
  }
  button?.addEventListener('click', () => {
    state.held = !state.held
    sync()
  })
  const plate = el.querySelector('[data-slot]') || el
  plate.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { state.hover = true; sync() } })
  plate.addEventListener('pointerleave', () => { state.hover = false; sync() })
  el.addEventListener('focusin', (e) => { if (e.target !== button) { state.focus = true; sync() } })
  el.addEventListener('focusout', () => { state.focus = false; sync() })
  new IntersectionObserver(([entry]) => {
    state.seen = entry.isIntersecting
    sync()
  }, { threshold: 0.35 }).observe(el)
  reduce.addEventListener('change', sync)
  const engage = () => {
    if (state.engaged) return
    state.engaged = true
    sync()
  }
  for (const type of ['scroll', 'pointermove', 'touchstart', 'keydown']) addEventListener(type, engage, { once: true, passive: true })
})

// ---- The page's beat strip: the section you are reading is the beat in ink, and the playhead sits on your place.
const strip = document.querySelector('[data-strip]')
if (strip) {
  const links = [...strip.querySelectorAll('a[href^="#"]')]
  const sections = links.map((a) => document.getElementById(a.hash.slice(1))).filter(Boolean)
  const playhead = strip.querySelector('[data-playhead]')
  const beats = strip.querySelector('.strip-beats')
  let queued = false
  let current = -1

  const place = () => {
    queued = false
    if (!strip.offsetParent) return
    const line = innerHeight * 0.4
    let index = -1
    let progress = 0
    sections.forEach((section, i) => {
      const box = section.getBoundingClientRect()
      if (box.top <= line) {
        index = i
        progress = Math.min(1, Math.max(0, (line - box.top) / Math.max(1, box.height)))
      }
    })
    // At the end of the page the last beat is reached even when the last section is short.
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 2) {
      index = sections.length - 1
      progress = 1
    }
    if (index !== current) {
      links.forEach((a, i) => (i === index ? a.setAttribute('aria-current', 'true') : a.removeAttribute('aria-current')))
      current = index
    }
    const width = beats.getBoundingClientRect().width
    const x = index < 0 ? 0 : ((index + progress) / sections.length) * width
    playhead.style.transform = `translateX(${x.toFixed(1)}px)`
  }
  const queue = () => {
    if (!queued) {
      queued = true
      requestAnimationFrame(place)
    }
  }
  addEventListener('scroll', queue, { passive: true })
  addEventListener('resize', queue)
  place()
}

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
  document.querySelectorAll('a[data-notify]').forEach((a) =>
    a.addEventListener('click', () => {
      if (source) source.value = a.dataset.notify
      input.focus({ preventScroll: true })
    })
  )
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

// ---- The switcher: its panels fade in when you change them, never on the first paint.
document.querySelectorAll('.jobs').forEach((jobs) => requestAnimationFrame(() => jobs.classList.add('is-ready')))
