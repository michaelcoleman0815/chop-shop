import { contextBridge, ipcRenderer } from 'electron'

/**
 * The export's 3D page (renderer/three.html, main/three-render.ts): the one
 * channel it talks on. The main process sends what to draw; the page answers
 * each message by its id. Nothing else of the app is reachable from it.
 */
contextBridge.exposeInMainWorld('scene3dHost', {
  on: (listener: (message: unknown) => void): void => {
    ipcRenderer.on('scene3d', (_event, message) => listener(message))
  },
  reply: (id: number, value: unknown): void => ipcRenderer.send('scene3d-reply', id, value)
})
