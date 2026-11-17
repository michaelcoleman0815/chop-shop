import { describe, expect, it } from 'vitest'
import { exportWait } from './exporting'

describe('one export at a time', () => {
  it('lets an export start when none runs', () => {
    expect(exportWait(null, { kind: 'clips' })).toBeNull()
    expect(exportWait(null, { kind: 'version', n: 3 })).toBeNull()
  })

  it('keeps the editor’s Export waiting while Export all runs, and Export all while it runs', () => {
    expect(exportWait({ kind: 'clips' }, { kind: 'version', n: 3 })).toBe(
      "I'm still exporting the clips. v3 can go once they're done."
    )
    expect(exportWait({ kind: 'version', n: 3 }, { kind: 'clips' })).toBe(
      "I'm still exporting v3. The clips can go once that's done."
    )
    expect(exportWait({ kind: 'clips' }, { kind: 'clips' })).toBe("I'm still exporting the clips.")
    expect(exportWait({ kind: 'version', n: 3 }, { kind: 'version', n: 4 })).toBe(
      "I'm still exporting v3. v4 can go once that's done."
    )
  })
})
