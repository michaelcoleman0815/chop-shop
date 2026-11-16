import { useState, type DragEvent } from 'react'
import { CORNERS, describeLearned, type Brand } from '../../../../shared/brand'
import { describeStyle } from '../../../../shared/presets'
import { api, mediaUrlFor } from '../api'
import { Button, Icon } from '../components/ui'
import { clock, isVideoFile } from '../format'
import type { Cutalong } from '../useCutalong'
import { Header } from './Header'
import { LearnSection } from './Learn'

/**
 * Your brand, on one calm page: the videos it learns from, how your edits
 * look, and how they should feel. Every change saves as it is made.
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

export function BrandPage({ app }: { app: Cutalong }): JSX.Element {
  const brand = app.brand
  const [dropping, setDropping] = useState(false)
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

  return (
    <>
      <Header>
        <span className="spacer" />
      </Header>
      <main className="cl-page">
        <div className="cl-page-inner">
          <h1 className="cl-page-title">Your brand</h1>
          <p className="cl-lede">What keeps every video yours. New edits get it automatically.</p>

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
                <div className="cl-progress">
                  <span>{app.brandProgress.stage}</span>
                  <span className="cl-progress-bar" aria-hidden="true">
                    <span style={{ width: `${Math.max(4, app.brandProgress.percent)}%` }} />
                  </span>
                </div>
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
                    <button type="button" aria-label={`Forget ${v.title}`} onClick={() => app.forgetBrandVideo(v.path)}>
                      <Icon.close />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <LearnSection app={app} />

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
              <span>Caption colours</span>
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
              <span>Captions</span>
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

          <label className="cl-toggle">
            <input type="checkbox" checked={brand.autoApply} onChange={(e) => set({ autoApply: e.target.checked })} />
            Use my brand on new edits and exports
          </label>
        </div>
      </main>
    </>
  )
}
