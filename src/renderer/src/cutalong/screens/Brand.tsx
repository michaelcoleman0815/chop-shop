import { useEffect, useState, type DragEvent } from 'react'
import { CORNERS, describeLearned, type Brand } from '../../../../shared/brand'
import { brandName } from '../../../../shared/brands'
import { MOTION_FONTS } from '../../../../shared/motion/fonts'
import { describeStyle } from '../../../../shared/presets'
import { PROFILES, profileById } from '../../../../shared/raw/profiles'
import { api, mediaUrlFor } from '../api'
import { Button, Icon } from '../components/ui'
import { Working } from '../components/Working'
import { clock, isVideoFile } from '../format'
import { collapse } from '../motion'
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

/** Subtitles, or captions the graphics draw: two lines, the key words big. */
const LOOKS = [
  ['clean', 'Subtitles'],
  ['hierarchy', 'Hierarchy']
] as const

/** The person's brands, which one is shown, and which one new chats use. */
function BrandList({ app }: { app: Cutalong }): JSX.Element {
  const { brands } = app
  const shown = app.brand
  const several = brands.brands.length > 1
  const isDefault = shown.id === brands.default
  const defaultName = brandName(brands.brands.find((b) => b.id === brands.default) ?? shown)
  return (
    <div className="cl-field">
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
              {brandName(b)}
            </button>
          ))}
        </div>
      )}
      <div className="cl-row">
        <p className="cl-aside">
          {several
            ? isDefault
              ? `${defaultName} is your default: new chats use it. Switch a chat's brand from its header.`
              : `New chats use ${defaultName}. Switch a chat to ${brandName(shown)} from its header.`
            : 'One brand per channel. Add another for a second channel.'}
        </p>
        {several && !isDefault && (
          <Button variant="text" onClick={() => app.makeDefaultBrand(shown.id)}>
            Make it the default
          </Button>
        )}
        <Button small onClick={app.newBrand}>
          Add a brand
        </Button>
      </div>
    </div>
  )
}

export function BrandPage({ app }: { app: Cutalong }): JSX.Element {
  const brand = app.brand
  const [dropping, setDropping] = useState(false)
  // Typed as one line and saved as a list when the field is left.
  const [products, setProducts] = useState(app.brand.products.join(', '))
  const [deleting, setDeleting] = useState(false)
  // Another brand shown: its own names to listen for, and no question left open.
  useEffect(() => {
    setProducts(brand.products.join(', '))
    setDeleting(false)
  }, [brand.id, brand.products])
  const set = (patch: Partial<Brand>): void => app.saveBrand({ ...brand, ...patch })
  const facts = describeStyle(brand.style).slice(0, 4)

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    setDropping(false)
    const paths = [...e.dataTransfer.files].filter((f) => isVideoFile(f.name)).map((f) => api.pathForFile(f))
    if (paths.length) void app.learnFrom(paths)
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

  /** A product's logo, named after its file until the name is changed. */
  const addProductLogo = async (): Promise<void> => {
    const picked = await api.chooseMedia()
    if (!picked || picked.kind !== 'image') return
    const file = picked.path.startsWith('data:') ? 'Logo' : (picked.path.split(/[\\/]/).pop() ?? 'Logo')
    const name =
      file
        .replace(/\.[^.]+$/, '')
        .replace(/[-_]+/g, ' ')
        .trim() || 'Logo'
    set({ logos: [...brand.logos.filter((l) => l.path !== picked.path), { name, path: picked.path }].slice(0, 24) })
  }

  return (
    <>
      <Header>
        <span className="spacer" />
      </Header>
      <main className="cl-page">
        <div className="cl-page-inner">
          <h1 className="cl-page-title">{app.brands.brands.length > 1 ? 'Your brands' : 'Your brand'}</h1>
          <p className="cl-lede">What keeps every video yours. New edits get it automatically.</p>

          <BrandList app={app} />

          <section className="cl-section" aria-labelledby="brand-videos">
            <h2 id="brand-videos">Your videos</h2>
            <p className="cl-reply">{describeLearned(brand)}</p>
            {facts.length > 0 && (
              <div className="cl-chips">
                {facts.map((f) => (
                  <span key={f} className="cl-fact">
                    {f}
                  </span>
                ))}
              </div>
            )}
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
            {brand.videos.length > 0 && (
              <ul className="cl-list">
                {brand.videos.map((v) => (
                  <li key={v.path}>
                    <span className="cl-list-main">
                      {v.title}
                      <span className="cl-project-meta">
                        {clock(v.facts.durationSec)} · {v.facts.secondsPerShot.toFixed(1)} s per shot
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

          <LearnSection app={app} />

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
                      <input
                        className="cl-list-main"
                        aria-label="Logo name"
                        value={l.name}
                        onChange={(e) =>
                          set({ logos: brand.logos.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })
                        }
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
                  const on = (caption.preset === 'hierarchy' ? 'hierarchy' : 'clean') === value
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
