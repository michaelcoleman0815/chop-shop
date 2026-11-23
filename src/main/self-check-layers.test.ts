import { describe, expect, it, vi } from 'vitest'

// The self-check runs in the app; here only its layered export, with Electron and the updater kept out.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '0', isPackaged: false, getAppPath: () => process.cwd() } }))
vi.mock('./updater', () => ({ RELEASES_URL: '' }))
import { layersExport } from './self-check'

/**
 * The layered export the app checks itself with (self-check.ts), run the same
 * way here, so a change to one family's drawing that spoils another's probe
 * shows in every run rather than on someone's Mac: a solid, a multiplied
 * solid, a title, particles, a masked solid and a sound, each read back.
 */
describe('the self-check’s layered export', () => {
  it('draws and mixes every kind of layer it checks, each where it is probed', async () => {
    const said = await layersExport()
    expect(said).toMatch(/multiplied 0,0,128/)
    expect(said).toMatch(/particles/)
    expect(said).toMatch(/masked/)
  }, 120_000)
})
