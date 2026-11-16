import { useEffect, useState, type FormEvent } from 'react'
import { DESCRIPTION_TEMPLATE_MAX, type Brand } from '../../../../shared/brand'
import { describeSources, MAX_SOURCE_LENGTH, MAX_SOURCES, readSources } from '../../../../shared/broll-sources'
import { brandInSentence } from '../../../../shared/brands'
import { listWords, neverName, readNever } from '../../../../shared/never'
import { Button, Icon } from '../components/ui'
import { collapse } from '../motion'
import type { Cutalong } from '../useCutalong'

/**
 * A brand's rules, on the Brand page: what the channel never uses, where its
 * B-roll comes from, and what goes in every export's description.
 */

const NEVER_HINT =
  'I can rule out sound effects, transitions, music beds, looks, punch-ins, camera moves, motion graphics, B-roll from outside, captions and black and white, or one kind of them, like zoom transitions or lower thirds.'

/** The never list (shared/never): from chats and from here, one list, kept with what was said. */
export function NeverSection({ app, brand }: { app: Cutalong; brand: Brand }): JSX.Element {
  const [typed, setTyped] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const list = app.neverOf(brand.id)
  const said = new Map(
    (app.memory.view.never ?? []).filter((e) => e.brand === brand.id).map((e) => [e.item, e.said] as const)
  )
  const name = brandInSentence(brand)

  const add = (e: FormEvent): void => {
    e.preventDefault()
    const words = typed.trim()
    if (!words) return
    const items = readNever(`never use ${words}`).never
    const fresh = items.filter((i) => !list.includes(i))
    if (items.length === 0) {
      setHint(`I can't rule out “${words}”. ${NEVER_HINT}`)
      return
    }
    if (fresh.length) void app.setNever(brand.id, fresh, true)
    setHint(fresh.length ? null : `${listWords(items.map(neverName))} ${items.length === 1 ? 'is' : 'are'} already on the list.`)
    setTyped('')
  }

  return (
    <section className="cl-section" aria-labelledby="brand-never">
      <h2 id="brand-never">Never on this channel</h2>
      <p className="cl-reply">
        {list.length
          ? `${name} never uses these. I leave them out of every change: /all, commands and what Claude plans.`
          : `Nothing is ruled out for ${name}. Say “never use whooshes” in a chat, or add one here.`}
      </p>
      {list.length > 0 && (
        <ul className="cl-list" aria-label={`What ${name} never uses`}>
          {list.map((item) => (
            <li key={item}>
              <span className="cl-list-main">
                {neverName(item)}
                <span className="cl-project-meta">{said.get(item) ? `You said “${said.get(item)}”` : 'Added here'}</span>
              </span>
              <button
                type="button"
                aria-label={`Take ${neverName(item).toLowerCase()} off the list`}
                onClick={(e) => collapse(e.currentTarget, () => void app.setNever(brand.id, [item], false))}
              >
                <Icon.close />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="cl-field" onSubmit={add}>
        <span className="sr-only">Add something this channel never uses</span>
        <div className="cl-row">
          <input
            aria-label="Something this channel never uses"
            value={typed}
            placeholder="Zoom transitions, whooshes, lower thirds"
            onChange={(e) => {
              setTyped(e.target.value)
              setHint(null)
            }}
          />
          <Button small type="submit" disabled={!typed.trim()}>
            Add
          </Button>
        </div>
      </form>
      {hint && (
        <p className="cl-aside" role="status">
          {hint}
        </p>
      )}
    </section>
  )
}

/** One list of sources, typed or pasted a line each, read as it is left. */
function SourceList({
  label,
  lines,
  placeholder,
  sentence,
  onSave
}: {
  label: string
  lines: string[]
  placeholder: string
  /** What the list does, said of what it holds: "I look in 2 channels first." */
  sentence: (what: string) => string
  onSave: (lines: string[]) => void
}): JSX.Element {
  const [text, setText] = useState(lines.join('\n'))
  useEffect(() => setText(lines.join('\n')), [lines])
  const entries = text.split(/\n/).map((l) => l.trim()).filter(Boolean)
  const read = readSources(entries)
  const over = entries.length > MAX_SOURCES
  // A brand keeps a line to MAX_SOURCE_LENGTH characters: any channel or site's address fits.
  const long = entries.some((l) => l.length > MAX_SOURCE_LENGTH)
  const says = [
    read.sources.length ? sentence(describeSources(read.sources)) : '',
    over ? `I keep the first ${MAX_SOURCES}.` : '',
    long ? `A line runs past ${MAX_SOURCE_LENGTH} characters, so I keep its first ${MAX_SOURCE_LENGTH}: paste the channel's own address instead.` : '',
    read.problems[0] ?? ''
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div className="cl-field">
      <label className="cl-field">
        <span>{label}</span>
        <textarea
          rows={3}
          value={text}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => onSave(entries.slice(0, MAX_SOURCES).map((l) => l.slice(0, MAX_SOURCE_LENGTH)))}
        />
      </label>
      {says && (
        <p className="cl-aside" role="status">
          {says}
        </p>
      )}
    </div>
  )
}

/** Where B-roll comes from (shared/broll-sources): channels and sites to look in first, and ones never to use. */
export function SourcesSection({ app, brand }: { app: Cutalong; brand: Brand }): JSX.Element {
  const set = (patch: Partial<Brand['broll']>): void => app.saveBrand({ ...brand, broll: { ...brand.broll, ...patch } })
  return (
    <section className="cl-section" aria-labelledby="brand-sources">
      <h2 id="brand-sources">B-roll sources</h2>
      <p className="cl-reply">
        When I look for B-roll, I search the channels you prefer first and never bring back the ones you block. Paste
        links or @handles, one a line.
      </p>
      <SourceList
        label="Look here first"
        lines={brand.broll.prefer}
        placeholder={'@veritasium\nyoutube.com/@nasa'}
        sentence={(what) => `I look in ${what} first.`}
        onSave={(prefer) => set({ prefer })}
      />
      <SourceList
        label="Never use"
        lines={brand.broll.block}
        placeholder={'@somechannel\nexample.com'}
        sentence={(what) => `Nothing from ${what} comes back.`}
        onSave={(block) => set({ block })}
      />
      <p className="cl-aside">
        I can only search inside YouTube channels. A website you prefer moves its results up when a search finds them.
      </p>
    </section>
  )
}

/** What goes in every export's description, around the parts made for each video (shared/upload). */
export function DescriptionSection({ app, brand }: { app: Cutalong; brand: Brand }): JSX.Element {
  return (
    <section className="cl-section" aria-labelledby="brand-description">
      <h2 id="brand-description">Description</h2>
      <p className="cl-reply">
        Every export gets a description from this. I fill in <span className="mono">{'{opening}'}</span>,{' '}
        <span className="mono">{'{chapters}'}</span> and <span className="mono">{'{credits}'}</span> for each video; the
        rest is yours: links, socials, a standing sponsor line.
      </p>
      <label className="cl-field">
        <span className="sr-only">The description template</span>
        <textarea
          rows={7}
          value={brand.description}
          spellCheck={false}
          onChange={(e) => app.saveBrand({ ...brand, description: e.target.value.slice(0, DESCRIPTION_TEMPLATE_MAX) })}
        />
      </label>
    </section>
  )
}
