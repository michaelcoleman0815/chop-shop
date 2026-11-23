import { useEffect, useState } from 'react'
import { shippedOn } from '../../../../shared/changelog'
import { api } from '../api'
import { CHANGES } from '../changelog'
import { Header } from './Header'

/**
 * The changelog: what changed in each version, newest first, from
 * CHANGELOG.md as this copy of the app was built (shared/changelog). One
 * sheet, one row a version: its number and the day it shipped, then its
 * changes, set to be read. The version this copy is says so beside its number.
 */
export function ChangelogPage(): JSX.Element {
  const [version, setVersion] = useState('')
  useEffect(() => {
    void api.getVersion().then(setVersion)
  }, [])

  return (
    <>
      <Header>
        <span className="spacer" />
      </Header>
      <main className="cl-page">
        <div className="cl-page-inner wide">
          <h1 className="cl-page-title">Changelog</h1>
          <p className="cl-lede">
            What changed in each version, newest first.
            {version && <span className="cl-lede-line"> You have {version}.</span>}
          </p>
          {CHANGES.length === 0 ? (
            <p className="cl-lede">This copy of Cutalong was built without its changelog.</p>
          ) : (
            <ol className="cl-changelog">
              {CHANGES.map((v) => (
                <li key={v.version} aria-labelledby={`version-${v.version}`}>
                  <div className="cl-changelog-when">
                    <h2 id={`version-${v.version}`}>{v.version}</h2>
                    {v.date && <time dateTime={v.date}>{shippedOn(v.date)}</time>}
                    {v.version === version && <span className="cl-set-tag">Yours</span>}
                  </div>
                  <ul className="cl-changelog-changes">
                    {v.changes.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          )}
        </div>
      </main>
    </>
  )
}
