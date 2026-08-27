/**
 * Rolling capture buffer.
 *
 * MediaRecorder is rotated on a short interval so every retained blob is a
 * complete, independently decodable WebM segment. Grabbing then means handing
 * the last few segments to ffmpeg and trimming the tail, rather than trying to
 * slice a single never-ending recording.
 */

const SEGMENT_MS = 4000

export interface BufferState {
  running: boolean
  bufferedSec: number
  sourceId: string | null
  error: string | null
  grabbing: boolean
}

type Listener = (s: BufferState) => void

class RollingBuffer {
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private segments: Blob[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private flush: (() => void) | null = null
  private listeners = new Set<Listener>()
  private keepSec = 60

  private state: BufferState = {
    running: false,
    bufferedSec: 0,
    sourceId: null,
    error: null,
    grabbing: false
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    fn(this.state)
    return () => this.listeners.delete(fn)
  }

  getState(): BufferState {
    return this.state
  }

  private set(patch: Partial<BufferState>): void {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((fn) => fn(this.state))
  }

  private mimeType(): string {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9',
      'video/webm'
    ]
    return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? 'video/webm'
  }

  private trim(): void {
    const keep = Math.ceil(this.keepSec / (SEGMENT_MS / 1000)) + 2
    while (this.segments.length > keep) this.segments.shift()
    this.set({ bufferedSec: Math.round((this.segments.length * SEGMENT_MS) / 1000) })
  }

  private rotate(): void {
    if (!this.stream || !this.state.running) return
    const rec = new MediaRecorder(this.stream, {
      mimeType: this.mimeType(),
      videoBitsPerSecond: 8_000_000
    })
    this.recorder = rec

    rec.ondataavailable = (e): void => {
      if (e.data && e.data.size > 0) {
        this.segments.push(e.data)
        this.trim()
      }
      if (this.flush) {
        const done = this.flush
        this.flush = null
        done()
      }
    }
    rec.onstop = (): void => {
      if (this.state.running) this.rotate()
    }

    rec.start()
    this.timer = setTimeout(() => {
      if (rec.state !== 'inactive') rec.stop()
    }, SEGMENT_MS)
  }

  async start(sourceId: string, keepSec: number, withAudio: boolean): Promise<void> {
    await this.stop()
    this.keepSec = keepSec
    try {
      // The main process resolves which screen or window this returns, from the
      // source the user picked in Settings.
      const video = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: withAudio
      })

      if (withAudio && video.getAudioTracks().length === 0) {
        // macOS only offers loopback audio on recent releases; fall back to the
        // microphone rather than silently recording nothing.
        try {
          const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
          mic.getAudioTracks().forEach((t) => video.addTrack(t))
        } catch {
          // A missing or refused microphone should not stop the video buffer.
        }
      }

      this.stream = video
      this.segments = []
      this.set({ running: true, sourceId, error: null, bufferedSec: 0 })
      this.rotate()
    } catch (err) {
      this.set({
        running: false,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  setKeepSec(sec: number): void {
    this.keepSec = sec
    this.trim()
  }

  async stop(): Promise<void> {
    this.set({ running: false })
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop()
    this.recorder = null
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.segments = []
    this.set({ bufferedSec: 0, sourceId: null })
  }

  /** Flushes the in-flight segment and returns everything currently buffered. */
  async grab(): Promise<ArrayBuffer[] | null> {
    if (!this.state.running || this.segments.length === 0) return null
    this.set({ grabbing: true })
    try {
      if (this.timer) clearTimeout(this.timer)
      await new Promise<void>((resolve) => {
        this.flush = resolve
        if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop()
        else resolve()
        setTimeout(resolve, 2000)
      })
      const snapshot = [...this.segments]
      return await Promise.all(snapshot.map((b) => b.arrayBuffer()))
    } finally {
      this.set({ grabbing: false })
    }
  }
}

export const rollingBuffer = new RollingBuffer()
