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
    return <p className="muted">No exports yet.</p>
  }

  return (
    <div>
      {jobs.map((job) => (
        <div key={job.id} className={`job ${job.stage}`}>
          <div className="row">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="name">{job.name}</div>
              <div className="label" style={{ letterSpacing: '0.1em' }}>
                {job.stage === 'error' ? 'Failed' : job.stage === 'done' ? 'Done' : `${job.percent}%`}
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
            <div className="mono muted" style={{ fontSize: 11, marginTop: 8 }}>
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
