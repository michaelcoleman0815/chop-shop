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
