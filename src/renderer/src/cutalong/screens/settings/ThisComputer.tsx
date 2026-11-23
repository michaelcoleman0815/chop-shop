import { useEffect, useState } from 'react'
import type { MapStatus } from '../../../../../shared/maps'
import { SIGN_IN_LOCKED, signInBrowsers } from '../../../../../shared/platform'
import type { Settings, UpdateState } from '../../../../../shared/types'
import { api, device } from '../../api'
import { CHANGES } from '../../changelog'
import { Button } from '../../components/ui'
import { grow } from '../../motion'
import { SetGroup, SetRow, SetSelect } from './rows'

/**
 * What belongs to this computer itself: where exports go, whose sign-in
 * video links may borrow, the sharper map pictures, updates, and the way to
 * the changelog.
 */

const phone = device.kind === 'phone'

/** The browsers offered, of those this computer can borrow a sign-in from (shared/platform). */
const BROWSERS: { id: string; label: string }[] = [
  { id: '', label: 'Off' },
  ...[
    { id: 'chrome', label: 'Chrome' },
    { id: 'safari', label: 'Safari' },
    { id: 'firefox', label: 'Firefox' },
    { id: 'edge', label: 'Edge' },
    { id: 'brave', label: 'Brave' }
  ].filter((b) => signInBrowsers().includes(b.id))
]

/** What the sign-in row says, with why on Windows it offers Firefox alone. */
const SIGN_IN_DESC = [
  'Some sites only hand a video to someone signed in. I can borrow the sign-in from a browser here.',
  SIGN_IN_LOCKED
]
  .filter(Boolean)
  .join(' ')

function updateLine(s: UpdateState, version: string): string {
  switch (s.status) {
    case 'checking':
      return 'Checking for an update…'
    case 'available':
      return `Version ${s.version} is out. You have ${version}.`
    case 'downloading':
      return `Downloading ${s.version}: ${Math.round(s.percent)}%.`
    case 'ready':
      return `${s.version} is downloaded. Restart Cutalong to finish.`
    case 'none':
      return `You have the latest version, ${s.version}.`
    case 'error':
      return s.message
    default:
      return `Version ${version}.`
  }
}

/** A row that opens the Changelog page: what changed in each version (CHANGELOG.md). */
function ChangelogRow({ onOpen }: { onOpen: () => void }): JSX.Element | null {
  const latest = CHANGES[0]
  if (!latest) return null
  return (
    <SetRow
      title="Changelog"
      desc={`What changed in ${latest.version} and the versions before it.`}
      find="changelog what's new changes version release notes"
      control={
        <Button small onClick={onOpen}>
          Open
        </Button>
      }
    />
  )
}

/** The sharper satellite pictures and plate boundaries, and a download for them with its progress. */
function MapsRow(): JSX.Element {
  const [status, setStatus] = useState<MapStatus | null>(null)
  const [percent, setPercent] = useState<number | null>(null)
  const [problem, setProblem] = useState<{ message: string; detail?: string } | null>(null)

  useEffect(() => {
    void api.mapStatus().then((s) => {
      setStatus(s)
      if (s.downloading) setPercent(0)
    })
    return api.onMapProgress((p) => {
      setPercent(p.percent >= 100 ? null : p.percent)
      if (p.percent >= 100) void api.mapStatus().then(setStatus)
    })
  }, [])

  const download = async (): Promise<void> => {
    setProblem(null)
    setPercent(0)
    try {
      const r = await api.downloadMaps()
      setStatus(r.status)
      if (!r.ok) setProblem({ message: r.message, detail: r.detail })
    } finally {
      setPercent(null)
    }
  }

  const size = status ? `${status.downloadMb} MB` : 'about 120 MB'
  const stopped = problem ?? status?.problem ?? null
  const done = status?.complete && percent === null
  return (
    <SetRow
      title="Map pictures"
      tag={done ? 'Downloaded' : undefined}
      desc={
        done
          ? `Sharp satellite pictures and the plate boundaries are on ${device.here}.`
          : (stopped?.message ??
            `Sharper pictures from NASA, with the plate boundaries: a ${size} download, fetched the first time a map needs them. The same files for everyone, so it says nothing about the places you map.`)
      }
      find="maps nasa satellite download"
      control={
        done || percent !== null ? undefined : (
          <Button small disabled={!status} onClick={() => void download()}>
            {stopped ? 'Try again' : 'Download'}
          </Button>
        )
      }
    >
      {percent !== null && (
        <div className="cl-progress">
          <span>Downloading map pictures</span>
          <span className="cl-progress-bar" aria-hidden="true">
            <span style={grow(Math.max(4, Math.min(100, percent)))} />
          </span>
        </div>
      )}
      {stopped?.detail && percent === null && (
        <dl className="cl-details">
          <dt>What the servers said</dt>
          <dd>{stopped.detail}</dd>
        </dl>
      )}
    </SetRow>
  )
}

export function ThisComputerSection({
  settings,
  onSettings,
  onChangelog
}: {
  settings: Settings | null
  onSettings: (next: Settings) => void
  /** Opens the Changelog page. */
  onChangelog: () => void
}): JSX.Element {
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle' })

  useEffect(() => {
    void api.getVersion().then(setVersion)
    void api.updateState().then(setUpdate)
    return api.onUpdateState(setUpdate)
  }, [])

  return (
    <SetGroup>
      <SetRow
        title="Exports"
        desc={
          device.savesTo ? (
            `Each export goes to ${device.savesTo}, and stays in Cutalong too.`
          ) : (
            <span className="cl-path mono" title={settings?.outputDir}>
              {settings?.outputDir ?? ''}
            </span>
          )
        }
        find="export folder output save where"
        control={
          device.savesTo ? undefined : (
            <Button
              small
              onClick={() =>
                void api.chooseOutputDir().then((dir) => dir && settings && onSettings({ ...settings, outputDir: dir }))
              }
            >
              Change…
            </Button>
          )
        }
      />
      {!device.away['feature:link'] && (
        <SetRow
          title="Sign-in for videos from links"
          desc={SIGN_IN_DESC}
          find="browser cookies chrome safari firefox link youtube"
          control={
            <SetSelect
              value={settings?.videoSignIn ?? ''}
              options={BROWSERS}
              disabled={!settings}
              onChange={(id) =>
                void api
                  .setVideoSignIn(id || null)
                  .then((videoSignIn) => settings && onSettings({ ...settings, videoSignIn }))
              }
            />
          }
        />
      )}
      {!device.away['feature:maps'] && <MapsRow />}
      {!phone && (
        <SetRow
          title="Updates"
          desc={updateLine(update, version)}
          find="version update download restart"
          control={
            update.status === 'available' ? (
              <Button small onClick={() => void api.downloadUpdate()}>
                Download {update.version}
              </Button>
            ) : update.status === 'ready' ? (
              <Button small onClick={() => void api.installUpdate()}>
                Restart to update
              </Button>
            ) : update.status === 'idle' || update.status === 'none' || update.status === 'error' ? (
              <Button small onClick={() => void api.checkForUpdates().then(setUpdate)}>
                Check
              </Button>
            ) : undefined
          }
        />
      )}
      <ChangelogRow onOpen={onChangelog} />
    </SetGroup>
  )
}
