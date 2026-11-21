import { useEffect, useState } from 'react'
import type { Device } from '../device'
import { Button } from '../components/ui'

/**
 * Settings' Licences, on a device that carries what it is built with inside
 * the app (a phone): FFmpeg and the other parts of the engine, the fonts,
 * the whisper models and the page's own libraries, each with its licence a
 * tap away; and for the parts under the LGPL, where their source is and how
 * to put a changed build of them in the app.
 */

interface Notices {
  source: { repository: string; folder: string }
  freetype: string
  components: { name: string; version: string; licence: string; lgpl?: boolean; text: string }[]
}

interface Package {
  name: string
  version: string
  licence: string
  text: string | null
}

/**
 * A licence as it reads at a phone's width: its paragraphs, each with its
 * lines joined, the words as they are.
 */
function LicenceText({ text }: { text: string }): JSX.Element {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  return (
    <div className="cl-licence">
      {paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </div>
  )
}

/** A text from inside the app, next to the page. */
async function read<T>(url: string, as: 'json' | 'text'): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return (as === 'json' ? await res.json() : await res.text()) as T
}

function Row({
  name,
  meta,
  open,
  onToggle,
  children
}: {
  name: string
  meta: string
  open: boolean
  onToggle: () => void
  children: JSX.Element | null
}): JSX.Element {
  return (
    <li>
      <span className="cl-list-main">
        {name}
        <span className="cl-project-meta">{meta}</span>
      </span>
      <Button
        variant="text"
        aria-expanded={open}
        aria-label={`${open ? 'Hide' : 'Read'} the licence of ${name}`}
        onClick={onToggle}
      >
        {open ? 'Hide' : 'Read'}
      </Button>
      {open && children}
    </li>
  )
}

export function Licences({ where, version }: { where: NonNullable<Device['licences']>; version: string }): JSX.Element {
  const [notices, setNotices] = useState<Notices | null>(null)
  const [packages, setPackages] = useState<Package[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [texts, setTexts] = useState<Record<string, string>>({})
  const [showPackages, setShowPackages] = useState(false)

  useEffect(() => {
    read<Notices>(where.notices, 'json')
      .then(setNotices)
      .catch(() => setFailed(true))
    read<Package[]>(where.packages, 'json')
      .then(setPackages)
      .catch(() => setPackages([]))
  }, [where])

  const toggle = (key: string, file?: string): void => {
    setOpen((now) => (now === key ? null : key))
    if (file && !texts[file]) {
      const url = new URL(file, new URL(where.notices, location.href)).href
      read<string>(url, 'text')
        .then((text) => setTexts((t) => ({ ...t, [file]: text })))
        .catch(() => setTexts((t) => ({ ...t, [file]: "I couldn't open this licence." })))
    }
  }

  const commit = where.commit ? where.commit.slice(0, 12) : null
  const source = notices?.source

  return (
    <div className="cl-set-card cl-set-prose cl-licences">
      {failed ? (
        <p className="cl-reply">I couldn't open the list of licences that comes with Cutalong.</p>
      ) : (
        <p className="cl-reply">
          Cutalong {version} is made with the software below. Each one's licence is here to read.
        </p>
      )}
      {source && (
        <p className="cl-aside">
          FFmpeg, FriBidi and the engine that runs them are under the GNU Lesser General Public License, version 2.1 or
          later. The source of exactly what is in this app, every change and the scripts that build it, is in{' '}
          <span className="mono">{source.folder}</span> at {source.repository}
          {commit ? (
            <>
              , as of commit <span className="mono">{commit}</span>
            </>
          ) : null}
          . They are separate libraries in the app, so you can build them from changed source with those scripts and put
          yours in their place. On an iPhone, whoever installs the changed app signs it again.
        </p>
      )}
      {notices && (
        <ul className="cl-list">
          {notices.components.map((c) => (
            <Row
              key={c.name}
              name={c.name}
              meta={[c.version, c.licence].filter(Boolean).join(' · ')}
              open={open === c.name}
              onToggle={() => toggle(c.name, c.text)}
            >
              <LicenceText text={texts[c.text] ?? 'Opening…'} />
            </Row>
          ))}
          {packages && packages.length > 0 && (
            <Row
              name="The libraries of the app's page"
              meta={`${packages.length} npm packages`}
              open={showPackages}
              onToggle={() => setShowPackages((s) => !s)}
            >
              <ul className="cl-list cl-licence-packages">
                {packages.map((p) => (
                  <Row
                    key={`${p.name}@${p.version}`}
                    name={p.name}
                    meta={`${p.version} · ${p.licence}`}
                    open={open === `npm:${p.name}@${p.version}`}
                    onToggle={() => toggle(`npm:${p.name}@${p.version}`)}
                  >
                    <LicenceText text={p.text ?? `${p.licence}. The package has no licence file.`} />
                  </Row>
                ))}
              </ul>
            </Row>
          )}
        </ul>
      )}
      {notices && <p className="cl-aside">{notices.freetype}</p>}
    </div>
  )
}
