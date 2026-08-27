export interface Job {
  id: string
  name: string
  percent: number
  stage: 'queued' | 'running' | 'done' | 'error'
  outputPath?: string
  message?: string
}

export default function JobList({ jobs }: { jobs: Job[] }): JSX.Element {
  if (jobs.length === 0) {
    return <p className="muted">Nothing exported yet. Clips land here as they render.</p>
  }

  return (
    <div>
      {jobs.map((job) => (
        <div key={job.id} className={`job ${job.stage}`}>
          <div className="row">
            <div className="grow" style={{ flex: 1, minWidth: 0 }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {job.name}
              </div>
              <div className="muted mono" style={{ fontSize: 11 }}>
                {job.stage === 'error' ? 'failed' : job.stage === 'done' ? 'done' : `${job.percent}%`}
              </div>
            </div>
            {job.stage === 'done' && job.outputPath && (
              <>
                <button className="ghost" onClick={() => window.chop.openPath(job.outputPath!)}>
                  Play
                </button>
                <button className="ghost" onClick={() => window.chop.reveal(job.outputPath!)}>
                  Show
                </button>
              </>
            )}
          </div>
          {job.stage === 'error' && job.message && (
            <div className="muted mono" style={{ fontSize: 11, marginTop: 6 }}>
              {job.message.split('\n').slice(-2).join(' ')}
            </div>
          )}
          <div className="bar">
            <i style={{ width: `${job.stage === 'error' ? 100 : job.percent}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}
