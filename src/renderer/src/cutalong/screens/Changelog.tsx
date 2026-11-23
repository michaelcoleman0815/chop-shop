import { useEffect, useState } from 'react'
import { shippedOn, type ChangelogVersion } from '../../../../shared/changelog'
import { api } from '../api'
import { CHANGES } from '../changelog'
import { Button } from '../components/ui'
import { Header } from './Header'

/**
 * The changelog: what changed in each version, newest first, from
 * CHANGELOG.md as this copy of the app was built (shared/changelog). One
 * sheet, one row a version: its number and the day it shipped, then its
 * changes, set to be read.
 *
 * On the first open of a new version it is what's new instead (App, with
 * shared/changelog whatsNewSince): the versions since the one opened before,
 * however many updates ago that was, each marked new, with one button back to
 * editing and the rest of the changelog a press away.
 */

export interface News {
  /** The version opened before, or null when it is not known. */
  from: string | null
  now: string
  /** The versions new since then, newest first. */
  versions: string[]
}

export function ChangelogPage({
  news,
  done
}: {
  news?: News | null
  /** Where what's new leaves for: back to the edit it opened over, or Start. */
  done?: { label: string; go: () => void }
}): JSX.Element {
  const [version, setVersion] = useState('')
  const [all, setAll] = useState(false)
  useEffect(() => {
    void api.getVersion().then(setVersion)
  }, [])

  const fresh = new Set(news?.versions ?? [])
  const shown = news && !all ? CHANGES.filter((v) => fresh.has(v.version)) : CHANGES

  return (
    <>
      <Header>
        <span className="spacer" />
      </Header>
      <main className="cl-page">
        <div className="cl-page-inner wide">
          {news ? (
            <>
              <h1 className="cl-page-title">What’s new in {news.now}</h1>
              <p className="cl-lede">
                {news.from
                  ? `What changed since ${news.from}, the version you last opened.`
                  : `Cutalong is now ${news.now}. Here is what changed.`}
              </p>
              {done && (
                <div className="cl-changelog-go">
                  <Button onClick={done.go}>{done.label}</Button>
                </div>
              )}
            </>
          ) : (
            <>
              <h1 className="cl-page-title">Changelog</h1>
              <p className="cl-lede">
                What changed in each version, newest first.
                {version && <span className="cl-lede-line"> You have {version}.</span>}
              </p>
            </>
          )}
          {CHANGES.length === 0 ? (
            <p className="cl-lede">This copy of Cutalong was built without its changelog.</p>
          ) : (
            <ol className="cl-changelog">
              {shown.map((v) => (
                <Version key={v.version} v={v} tag={fresh.has(v.version) ? 'New' : v.version === version ? 'Installed' : null} />
              ))}
            </ol>
          )}
          {news && CHANGES.length > shown.length && (
            <Button variant="text" small onClick={() => setAll(true)}>
              Every version
            </Button>
          )}
        </div>
      </main>
    </>
  )
}

function Version({ v, tag }: { v: ChangelogVersion; tag: string | null }): JSX.Element {
  return (
    <li aria-labelledby={`version-${v.version}`}>
      <div className="cl-changelog-when">
        <h2 id={`version-${v.version}`}>{v.version}</h2>
        {tag && <span className="cl-set-tag">{tag}</span>}
        {v.date && <time dateTime={v.date}>{shippedOn(v.date)}</time>}
      </div>
      <ul className="cl-changelog-changes">
        {v.changes.map((c, i) => (
          <li key={i}>{c}</li>
        ))}
      </ul>
    </li>
  )
}
