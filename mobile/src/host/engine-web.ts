import { WebPlugin } from '@capacitor/core'
import type { EngineInfo, EngineLine, EnginePlugin, EngineRunOptions, EngineRunResult, PickedFile } from 'cutalong-engine'

/**
 * CutalongEngine in a browser: every call goes to the dev bridge, which
 * serves this page and runs the real ffmpeg and ffprobe (and a stand-in for
 * whisper) on the computer it runs on. Lines come back over server-sent
 * events, as the native plugin's 'line' events do. Only for working on the
 * app: a phone has the native plugin, and this never loads there.
 */

/** Where the bridge answers: the page's own origin, as the bridge serves it. */
export const BRIDGE = '/engine'

async function call<T>(op: string, body: unknown): Promise<T> {
  const res = await fetch(`${BRIDGE}/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error((await res.text().catch(() => '')) || `The engine bridge answered ${res.status}.`)
  return (await res.json()) as T
}

const ACCEPT: Record<'video' | 'audio' | 'image', string> = { video: 'video/*', audio: 'audio/*', image: 'image/*' }

export class EngineWeb extends WebPlugin implements EnginePlugin {
  private events: EventSource | null = null

  private listen(): void {
    if (this.events) return
    this.events = new EventSource(`${BRIDGE}/lines`)
    this.events.onmessage = (e) => this.notifyListeners('line', JSON.parse(e.data as string) as EngineLine)
  }

  async addListener(eventName: 'line', listenerFunc: (line: EngineLine) => void): Promise<never> {
    this.listen()
    return super.addListener(eventName, listenerFunc) as Promise<never>
  }

  run(options: EngineRunOptions): Promise<EngineRunResult> {
    this.listen()
    return call<EngineRunResult>('run', options)
  }

  async cancel(options: { id: string }): Promise<void> {
    await call('cancel', options)
  }

  /**
   * Files the bridge was told to hand over next, or ones chosen here and
   * copied into the app's storage, as a phone's picker copies them in.
   */
  async pick(options: { multiple: boolean; kinds: Array<'video' | 'audio' | 'image'> }): Promise<{ files: PickedFile[] }> {
    const queued = await call<{ files: PickedFile[] | null }>('pick', options)
    if (queued.files) return { files: queued.files }
    const chosen = await new Promise<File[]>((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = options.multiple
      input.accept = options.kinds.map((k) => ACCEPT[k]).join(',')
      input.style.display = 'none'
      input.addEventListener('change', () => resolve([...(input.files ?? [])]))
      input.addEventListener('cancel', () => resolve([]))
      document.body.appendChild(input)
      input.click()
      setTimeout(() => input.remove(), 60_000)
    })
    const files: PickedFile[] = []
    for (const file of chosen) {
      const res = await fetch(`${BRIDGE}/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file })
      if (res.ok) files.push((await res.json()) as PickedFile)
    }
    return { files }
  }

  saveToPhotos(options: { path: string }): Promise<{ saved: boolean; message?: string }> {
    return call('photos', options)
  }

  info(): Promise<EngineInfo> {
    return call<EngineInfo>('info', {})
  }
}
