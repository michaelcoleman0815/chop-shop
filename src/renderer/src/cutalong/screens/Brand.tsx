import { useEffect, useState, type CSSProperties, type DragEvent, type KeyboardEvent } from 'react'
import { CORNERS, describeLearned, LOGO_NAME_MAX, MAX_LOGOS, type Brand } from '../../../../shared/brand'
import { brandName } from '../../../../shared/brands'
import { describeHabits } from '../../../../shared/channel-habits'
import { MOTION_FONTS } from '../../../../shared/motion/fonts'
import { describeStyle } from '../../../../shared/presets'
import { PROFILES, profileById } from '../../../../shared/raw/profiles'
import { api, device, mediaUrlFor } from '../api'
import { Facts } from '../components/Message'
import { Blob, BrandAvatar } from '../components/Shapes'
import { Button, Icon } from '../components/ui'
import { Working } from '../components/Working'
import { clock, isVideoFile } from '../format'
import { collapse } from '../motion'
import {
  avatarOf,
  block,
  bloom,
  COLOUR_NAMES,
  COLOURS,
  SHAPE_NAMES,
  SHAPES,
  type Avatar
} from '../shapes'
import type { Cutalong } from '../useCutalong'
import { Header } from './Header'
import { LearnSection } from './Learn'
import { MemorySection } from './Memory'
import { DescriptionSection, NeverSection, SourcesSection } from './BrandRules'

/**
 * Your brands, on one calm page: one per channel, and for the one shown, the
 * videos it learns from, how its edits look, how they should feel, what it
 * never uses, where its B-roll comes from and what its descriptions say.
 * Every change saves as it is made.
 */

const CORNER_NAMES: Record<(typeof CORNERS)[number], string> = {
  'top-left': 'Top left',
  'top-right': 'Top right',
  'bottom-left': 'Bottom left',
  'bottom-right': 'Bottom right'
}

const POSITIONS = [
  ['top', 'Top'],
  ['middle', 'Middle'],
  ['chest', 'Chest'],
  ['bottom', 'Low']
] as const

/** Subtitles, or captions the graphics draw: two lines with the key words big, or the word being said in a box. */
const LOOKS = [
  ['clean', 'Subtitles'],
  ['hierarchy', 'Hierarchy'],
  ['boxed', 'Boxed']
] as const

/**
 * A product logo's name, as long as a brand keeps one. Saved as it is typed,
 * except while it is empty: cleared to type it again, it stays on the page
 * and comes back as it was if it is left empty.
 */
function LogoName({ name, onSave }: { name: string; onSave: (name: string) => void }): JSX.Element {
  const [text, setText] = useState(name)
  useEffect(() => setText(name), [name])
  return (
    <input
      className="cl-list-main"
      aria-label="Logo name"
      value={text}
      maxLength={LOGO_NAME_MAX}
      onChange={(e) => {
        const next = e.target.value.slice(0, LOGO_NAME_MAX)
        setText(next)
        if (next.trim()) onSave(next)
      }}
      onBlur={() => {
        if (!text.trim()) setText(name)
      }}
    />
  )
}

/** The person's brands, which one is shown, and which one new chats use. */
function BrandList({ app }: { app: Cutalong }): JSX.Element {
  const { brands } = app
  const shown = app.brand
  const several = brands.brands.length > 1
  const isDefault = shown.id === brands.default
  const defaultName = brandName(brands.brands.find((b) => b.id === brands.default) ?? shown)
  return (
    <div className="cl-brand-bar">
      {several && (
        <div className="cl-segments" role="radiogroup" aria-label="Brand">
          {brands.brands.map((b) => (
            <button
              key={b.id}
              type="button"
              role="radio"
              aria-checked={b.id === shown.id}
              className={b.id === shown.id ? 'on' : ''}
              onClick={() => app.showBrand(b.id)}
            >
              <Blob {...avatarOf(b)} size={14} className="cl-seg-blob" />
              {brandName(b)}
            </button>
          ))}
        </div>
      )}
      <span className="spacer" />
      {several && !isDefault && (
        <Button variant="text" onClick={() => app.makeDefaultBrand(shown.id)}>
          Make it the default
        </Button>
      )}
      <Button small onClick={app.newBrand}>
        Add a brand
      </Button>
      <p className="cl-aside cl-brand-note">
          {several
            ? isDefault
              ? `${defaultName} is your default: new chats use it. Switch a chat's brand from its header.`
              : `New chats use ${defaultName}. Switch a chat to ${brandName(shown)} from its header.`
            : 'One brand per channel. Add another for a second channel.'}
      </p>
    </div>
  )
}

/** Arrows, Home and End move through a radio group, choosing as they go. */
function radioKeys<T>(e: KeyboardEvent<HTMLElement>, items: readonly T[], at: number, pick: (item: T) => void): void {
  const next =
    e.key === 'ArrowRight' || e.key === 'ArrowDown'
      ? at + 1
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
        ? at - 1
        : e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? items.length - 1
            : null
  if (next === null) return
  e.preventDefault()
  const i = (next + items.length) % items.length
  pick(items[i])
  // The radio for it is drawn again with tabIndex 0; focus follows it there.
  const group = e.currentTarget.closest('[role="radiogroup"]')
  requestAnimationFrame(() => group?.querySelectorAll<HTMLElement>('[role="radio"]')[i]?.focus())
}

/**
 * A brand's shape and colour, picked like a sticker: every shape in the
 * brand's colour, then the colours. The avatar above morphs as you choose.
 */
function AvatarPicker({ value, onPick }: { value: Avatar; onPick: (a: Avatar) => void }): JSX.Element {
  const shapeAt = SHAPES.indexOf(value.shape)
  const colourAt = COLOURS.indexOf(value.colour)
  return (
    <div className="cl-avatar-picker">
      <div className="cl-pick-shapes" role="radiogroup" aria-label="Shape">
        {SHAPES.map((shape) => (
          <button
            key={shape}
            type="button"
            role="radio"
            aria-checked={shape === value.shape}
            aria-label={SHAPE_NAMES[shape]}
            title={SHAPE_NAMES[shape]}
            tabIndex={shape === value.shape ? 0 : -1}
            onClick={() => onPick({ ...value, shape })}
            onKeyDown={(e) => radioKeys(e, SHAPES, shapeAt, (s) => onPick({ ...value, shape: s }))}
          >
            <Blob shape={shape} colour={value.colour} size={30} />
          </button>
        ))}
      </div>
      <div className="cl-pick-colours" role="radiogroup" aria-label="Colour">
        {COLOURS.map((colour) => (
          <button
            key={colour}
            type="button"
            role="radio"
            aria-checked={colour === value.colour}
            aria-label={COLOUR_NAMES[colour]}
            title={COLOUR_NAMES[colour]}
            tabIndex={colour === value.colour ? 0 : -1}
            style={{ '--bloom': bloom(colour) } as CSSProperties}
            onClick={() => onPick({ ...value, colour })}
            onKeyDown={(e) => radioKeys(e, COLOURS, colourAt, (c) => onPick({ ...value, colour: c }))}
          >
            <span className="cl-swatch" />
          </button>
        ))}
      </div>
    </div>
  )
}

/** A link as typed or dropped, with its scheme; null for anything that is not one. */
function linkOf(text: string): string | null {
  const t = text.trim()
  if (!t || /\s/.test(t)) return null
  if (/^https?:\/\/[^/\s]+\.[^/\s]+/i.test(t)) return t
  return /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S+$/i.test(t) ? `https://${t}` : null
}

/**
 * How the brand's videos run, learned with their look: a plain sentence, three
 * facts at most, the numbers behind Details, and what could not be learned,
 * said as plainly. Nothing shows until a video has been learned.
 */
function RunsSection({ brand }: { brand: Brand }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const said = describeHabits(brand.videos)
  if (!said) return null
  return (
    <section className="cl-section" aria-labelledby="brand-runs">
      <h2 id="brand-runs">How your videos run</h2>
      <p className="cl-reply">{said.sentence}</p>
      <Facts facts={said.facts} seed={`${brand.id}-runs`} />
      <div className="cl-chips">
        <button type="button" className="cl-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide details' : 'Details'}
        </button>
      </div>
      {open && (
        <dl className="cl-details">
          {said.details.map((d) => (
            <div key={d.label} style={{ display: 'contents' }}>
              <dt>{d.label}</dt>
              <dd>{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {said.missing.length > 0 && <p className="cl-aside">{said.missing.slice(0, 3).join(' ')}</p>}
    </section>
  )
}

export function BrandPage({ app }: { app: Cutalong }): JSX.Element {
  const brand = app.brand
  const [dropping, setDropping] = useState(false)
  // Typed as one line and saved as a list when the field is left.
  const [products, setProducts] = useState(app.brand.products.join(', '))
  const [deleting, setDeleting] = useState(false)
  // A link to one of their videos, typed or pasted, until it is added.
  const [link, setLink] = useState('')
  // A brand just made, or one never named, opens with its shape and colour to pick, like a new sticker.
  const fresh = !brand.avatar && (brand.id === app.madeBrandId || !brand.name)
  const [picking, setPicking] = useState(fresh)
  // Another brand shown: its own names to listen for, and no question left open.
  useEffect(() => {
    setProducts(brand.products.join(', '))
    setDeleting(false)
  }, [brand.id, brand.products])
  useEffect(() => setPicking(fresh), [brand.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const avatar = avatarOf(brand)
  // On a phone, learning a look from videos and edits is on the Mac for now (device.ts).
  const learnAway = device.away['feature:learn']
  const set = (patch: Partial<Brand>): void => app.saveBrand({ ...brand, ...patch })
  const facts = describeStyle(brand.style)

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    setDropping(false)
    const paths = [...e.dataTransfer.files].filter((f) => isVideoFile(f.name)).map((f) => api.pathForFile(f))
    if (paths.length) {
      void app.learnFrom(paths)
      return
    }
    // A link dragged from a browser: its length and captions.
    const listed = e.dataTransfer.getData('text/uri-list').split('\n').find((l) => l.trim() && !l.startsWith('#'))
    const dropped = linkOf(listed ?? e.dataTransfer.getData('text/plain'))
    if (dropped) void app.learnFrom([dropped])
  }

  const addLink = (): void => {
    const url = linkOf(link)
    if (!url) return
    setLink('')
    void app.learnFrom([url])
  }

  const addVideo = async (): Promise<void> => {
    const meta = await api.openVideo()
    if (meta) void app.learnFrom([meta.path])
  }

  const chooseLogo = async (): Promise<void> => {
    const picked = await api.chooseMedia()
    if (picked && picked.kind === 'image') {
      set({
        logo: { path: picked.path, corner: brand.logo?.corner ?? 'top-right', opacity: brand.logo?.opacity ?? 0.9 }
      })
    }
  }

  const caption = brand.captions

  /** A product's logo, named after its file (as long a name as a brand keeps) until the name is changed. */
  const addProductLogo = async (): Promise<void> => {
    const picked = await api.chooseMedia()
    if (!picked || picked.kind !== 'image') return
    const others = brand.logos.filter((l) => l.path !== picked.path)
    if (others.length >= MAX_LOGOS) {
      app.setToast({ text: `A brand keeps ${MAX_LOGOS} product logos. Remove one to add another.`, error: true })
      return
    }
    const file = picked.path.startsWith('data:') ? 'Logo' : (picked.path.split(/[\\/]/).pop() ?? 'Logo')
    const named = file
      .replace(/\.[^.]+$/, '')
      .replace(/[-_]+/g, ' ')
      .trim()
    // Too long a file name is cut where a word ends; one long word, where it has to be.
    const cut = named.length > LOGO_NAME_MAX ? named.slice(0, LOGO_NAME_MAX + 1).replace(/\s+\S*$/, '') : named
    const name = cut.slice(0, LOGO_NAME_MAX).trim() || 'Logo'
    set({ logos: [...others, { name, path: picked.path }] })
  }

  return (
    <>
      <Header>
        <span className="spacer" />
      </Header>
      <main className="cl-page">
        <div className="cl-page-inner">
          <BrandList app={app} />

          <section
            className={`cl-brand-hero${picking ? ' picking' : ''}`}
            style={{ '--block': block(avatar.colour) } as CSSProperties}
            aria-labelledby="brand-name"
          >
            <BrandAvatar avatar={avatar} size={88} className="cl-brand-hero-avatar" />
            <div className="cl-brand-hero-text">
              <h1 className="cl-page-title" id="brand-name">
                {brandName(brand)}
              </h1>
              <p className="cl-lede">
                What keeps every video <span className="cl-accent">yours</span>. New edits get it automatically.
              </p>
            </div>
            <Button small aria-expanded={picking} onClick={() => setPicking((p) => !p)}>
              {picking ? 'Done' : 'Shape and colour'}
            </Button>
            {picking && <AvatarPicker value={avatar} onPick={(a) => set({ avatar: a })} />}
          </section>

          <section className="cl-section" aria-labelledby="brand-videos">
            <h2 id="brand-videos">Your videos</h2>
            <p className="cl-reply">{learnAway && brand.videos.length === 0 ? learnAway : describeLearned(brand)}</p>
            <Facts facts={facts} seed={brand.id} />
            {!learnAway && (
              <>
                <div
                  className={`cl-drop${dropping ? ' dropping' : ''}`}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDropping(true)
                  }}
                  onDragLeave={() => setDropping(false)}
                  onDrop={onDrop}
                >
                  {app.brandProgress ? (
                    <Working progress={app.brandProgress} />
                  ) : (
                    <>
                      <span>Drop videos you&apos;ve made, and I&apos;ll learn your look from them.</span>
                      <Button small onClick={() => void addVideo()}>
                        Add a video
                      </Button>
                    </>
                  )}
                </div>
                <form
                  className="cl-row cl-brand-link"
                  onSubmit={(e) => {
                    e.preventDefault()
                    addLink()
                  }}
                >
                  <label className="cl-field">
                    <span className="sr-only">A link to one of your videos</span>
                    <input
                      type="url"
                      inputMode="url"
                      spellCheck={false}
                      value={link}
                      placeholder="Or paste a link to one of your videos"
                      onChange={(e) => setLink(e.target.value)}
                    />
                  </label>
                  <Button small type="submit" disabled={!linkOf(link) || app.brandProgress !== null}>
                    Add the link
                  </Button>
                </form>
                <p className="cl-aside">A link gives me its length and captions; a file gives me everything.</p>
              </>
            )}
            {brand.videos.length > 0 && (
              <ul className="cl-list">
                {brand.videos.map((v) => (
                  <li key={v.path}>
                    <span className="cl-list-main">
                      {v.title}
                      <span className="cl-project-meta">
                        {v.facts
                          ? `${clock(v.facts.durationSec)} · ${v.facts.secondsPerShot.toFixed(1)} s per shot`
                          : `${clock(v.run?.durationSec ?? 0)} · ${v.run?.heard ? 'link and its captions' : 'link, no captions'}`}
                      </span>
                    </span>
                    <button
                      type="button"
                      aria-label={`Forget ${v.title}`}
                      onClick={(e) => collapse(e.currentTarget, () => app.forgetBrandVideo(v.path))}
                    >
                      <Icon.close />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {!learnAway && <RunsSection key={brand.id} brand={brand} />}

          {!learnAway && <LearnSection app={app} />}

          <MemorySection app={app} />

          <section className="cl-section" aria-labelledby="brand-look">
            <h2 id="brand-look">Look</h2>
            <label className="cl-field">
              <span>Name</span>
              <input value={brand.name} placeholder="Field Notes" onChange={(e) => set({ name: e.target.value })} />
            </label>

            <div className="cl-field">
              <span>Logo</span>
              <div className="cl-row">
                {brand.logo && (
                  <img
                    className="cl-logo-thumb"
                    src={mediaUrlFor(brand.logo.path)}
                    alt="Your logo"
                    width={44}
                    height={44}
                  />
                )}
                <Button small onClick={() => void chooseLogo()}>
                  {brand.logo ? 'Change' : 'Add a logo'}
                </Button>
                {brand.logo && (
                  <Button variant="text" onClick={() => set({ logo: null })}>
                    Remove
                  </Button>
                )}
              </div>
              {brand.logo && (
                <div className="cl-segments" role="radiogroup" aria-label="Logo corner">
                  {CORNERS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={brand.logo?.corner === c}
                      className={brand.logo?.corner === c ? 'on' : ''}
                      onClick={() => brand.logo && set({ logo: { ...brand.logo, corner: c } })}
                    >
                      {CORNER_NAMES[c]}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="cl-field">
              <span>Product logos</span>
              <span className="muted cl-field-hint">They pop in when you name them, with /logo or in a request.</span>
              {brand.logos.length > 0 && (
                <ul className="cl-list">
                  {brand.logos.map((l, i) => (
                    <li key={l.path}>
                      <img className="cl-logo-thumb" src={mediaUrlFor(l.path)} alt="" width={44} height={44} />
                      <LogoName
                        name={l.name}
                        onSave={(name) => set({ logos: brand.logos.map((x, j) => (j === i ? { ...x, name } : x)) })}
                      />
                      <button
                        type="button"
                        aria-label={`Remove ${l.name || 'this logo'}`}
                        onClick={() => set({ logos: brand.logos.filter((_, j) => j !== i) })}
                      >
                        <Icon.close />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="cl-row">
                <Button small onClick={() => void addProductLogo()}>
                  Add a product logo
                </Button>
              </div>
            </div>

            <div className="cl-field">
              <span>Colours</span>
              <span className="muted cl-field-hint">For the captions and the graphics.</span>
              <div className="cl-row">
                <label className="cl-swatch">
                  <input
                    type="color"
                    value={brand.colors.text}
                    onChange={(e) => set({ colors: { ...brand.colors, text: e.target.value.toUpperCase() } })}
                  />
                  Words
                </label>
                <label className="cl-swatch">
                  <input
                    type="color"
                    value={brand.colors.accent}
                    onChange={(e) => set({ colors: { ...brand.colors, accent: e.target.value.toUpperCase() } })}
                  />
                  The word being said
                </label>
                <span className="cl-caption-sample" aria-hidden="true">
                  <span style={{ color: brand.colors.text }}>Most people </span>
                  <span style={{ color: brand.colors.accent }}>never</span>
                </span>
              </div>
            </div>

            <div className="cl-field">
              <span>Graphics</span>
              <span className="muted cl-field-hint">Lower thirds, titles and pops use the colours above and these faces.</span>
              {(
                [
                  ['display', 'Headings', 'Archivo Black'],
                  ['body', 'Everything smaller', 'Sora']
                ] as const
              ).map(([part, label, fallback]) => (
                <div key={part} className="cl-row">
                  <span className="muted cl-row-label" aria-hidden="true">
                    {label}
                  </span>
                  <div className="cl-segments" role="radiogroup" aria-label={`${label} in graphics`}>
                    {MOTION_FONTS.map((f) => {
                      const on = (brand.fonts[part] ?? fallback) === f.family
                      return (
                        <button
                          key={f.family}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          title={f.label}
                          className={on ? 'on' : ''}
                          onClick={() => set({ fonts: { ...brand.fonts, [part]: f.family } })}
                        >
                          {f.family}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>

            <div className="cl-field">
              <span>Captions</span>
              <div className="cl-segments" role="radiogroup" aria-label="Caption look">
                {LOOKS.map(([value, label]) => {
                  const on = (LOOKS.some(([v]) => v === caption.preset) ? caption.preset : 'clean') === value
                  return (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      className={on ? 'on' : ''}
                      onClick={() => set({ captions: { ...caption, preset: value } })}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
              <div className="cl-segments" role="radiogroup" aria-label="Words at a time">
                {[1, 2, 3, 4].map((n) => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={caption.wordsPerScreen === n}
                    className={caption.wordsPerScreen === n ? 'on' : ''}
                    onClick={() => set({ captions: { ...caption, wordsPerScreen: n } })}
                  >
                    {n === 1 ? '1 word' : `${n} words`}
                  </button>
                ))}
              </div>
              <div className="cl-segments" role="radiogroup" aria-label="Caption position">
                {POSITIONS.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={caption.position === value}
                    className={caption.position === value ? 'on' : ''}
                    onClick={() => set({ captions: { ...caption, position: value } })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="cl-section" aria-labelledby="brand-voice">
            <h2 id="brand-voice">Voice</h2>
            <label className="cl-field">
              <span className="sr-only">How your edits should feel</span>
              <textarea
                rows={3}
                value={brand.voice}
                placeholder="How should your edits feel? For example: warm and quick, no swearing, always end on a question."
                onChange={(e) => set({ voice: e.target.value })}
              />
            </label>
          </section>

          <NeverSection app={app} brand={brand} />

          <SourcesSection app={app} brand={brand} />

          <DescriptionSection app={app} brand={brand} />

          <section className="cl-section" aria-labelledby="brand-niche">
            <h2 id="brand-niche">Raw footage</h2>
            <div className="cl-field">
              <span>What you make</span>
              <div className="cl-segments" role="radiogroup" aria-label="What you make">
                {[{ id: '', name: 'From the words' }, ...PROFILES].map((p) => (
                  <button
                    key={p.id || 'auto'}
                    type="button"
                    role="radio"
                    aria-checked={brand.niche === p.id}
                    className={brand.niche === p.id ? 'on' : ''}
                    onClick={() => set({ niche: p.id })}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
              <p className="cl-aside">
                {profileById(brand.niche)?.says.replace(/^I cut it/, 'I cut your footage') ??
                  'I tell from the words what kind of video it is, and cut it that way.'}
              </p>
            </div>
            <label className="cl-field">
              <span>Names to listen for</span>
              <input
                value={products}
                placeholder="Pixel 9 Pro, M4 MacBook Air, ZV-E10"
                onChange={(e) => setProducts(e.target.value)}
                onBlur={() =>
                  set({
                    products: products
                      .split(',')
                      .map((x) => x.trim())
                      .filter(Boolean)
                      .slice(0, 30)
                  })
                }
              />
            </label>
          </section>

          <label className="cl-toggle">
            <input type="checkbox" checked={brand.autoApply} onChange={(e) => set({ autoApply: e.target.checked })} />
            {app.brands.brands.length > 1
              ? `Use ${brandName(brand)} on the edits made in it and their exports`
              : 'Use my brand on new edits and exports'}
          </label>

          {app.brands.brands.length > 1 &&
            (deleting ? (
              <div className="cl-row">
                <p className="cl-aside">
                  Delete {brandName(brand)}? Edits made in it use your default brand from then on.
                </p>
                <Button variant="text" onClick={() => app.deleteBrand(brand.id)}>
                  Delete it
                </Button>
                <Button variant="text" onClick={() => setDeleting(false)}>
                  Keep it
                </Button>
              </div>
            ) : (
              <div className="cl-row">
                <Button variant="text" onClick={() => setDeleting(true)}>
                  Delete this brand
                </Button>
              </div>
            ))}
        </div>
      </main>
    </>
  )
}
