import { useEffect, useState } from 'react'
import { shippedOn, type ChangelogVersion } from '../../../../../shared/changelog'
import { api } from '../../api'
import { CHANGES } from '../../changelog'
import { Button } from '../../components/ui'

/**
 * The changelog in Settings: what changed in each version, newest first, from
 * CHANGELOG.md as this copy of the app was built (shared/changelog), on one
 * sheet, a row a version.
 *
 * On the first open of a new version Settings opens here (App, with
 * shared/changelog whatsNewSince): the versions since the one opened before,
 * however many updates ago that was, each marked new, with one button back to
 * where the app opened and the rest of the changelog a press away.
 */

export interface News {
  /** The version opened before, or null when it is not known. */
  from: string | null
  now: string
  /** The versions new since then, newest first. */
  versions: string[]
}

export function ChangelogSection({
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

  if (CHANGES.length === 0) return <p className="cl-set-desc">This copy of Cutalong was built without its changelog.</p>
  const fresh = new Set(news?.versions ?? [])
  const shown = news && !all ? CHANGES.filter((v) => fresh.has(v.version)) : CHANGES

  return (
    <>
      {news ? (
        <div className="cl-changelog-news">
          <p className="cl-changelog-lede" role="status">
            {news.from
              ? `Cutalong is now ${news.now}. Here is what changed since ${news.from}, the version you last opened.`
              : `Cutalong is now ${news.now}. Here is what changed.`}
          </p>
          {done && <Button onClick={done.go}>{done.label}</Button>}
        </div>
      ) : (
        <p className="cl-changelog-lede">
          What changed in each version, newest first.{version && ` You have ${version}.`}
        </p>
      )}
      <ol className="cl-changelog">
        {shown.map((v) => (
          <Version key={v.version} v={v} tag={fresh.has(v.version) ? 'New' : v.version === version ? 'Installed' : null} />
        ))}
      </ol>
      {news && CHANGES.length > shown.length && (
        <Button variant="text" small onClick={() => setAll(true)}>
          Every version
        </Button>
      )}
    </>
  )
}

function Version({ v, tag }: { v: ChangelogVersion; tag: string | null }): JSX.Element {
  return (
    <li aria-labelledby={`version-${v.version}`}>
      <div className="cl-changelog-when">
        <h3 id={`version-${v.version}`}>{v.version}</h3>
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
