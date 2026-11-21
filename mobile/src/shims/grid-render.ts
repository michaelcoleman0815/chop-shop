import type { Segment } from '../../../src/main/cut-render'
import type { GridInput } from '../../../src/main/grid-render'
import { ON_THE_MAC } from '../host/limits'

/**
 * A grid's ground and labels as the phone's page sees them. The export draws
 * them on the Mac's Skia (src/main/grid-render.ts), which a phone does not
 * have, so grids are on the Mac for now (host/limits.ts) and an export with
 * one is refused before it starts (host/api.ts, phoneWork). Reached anyway,
 * this says so.
 */
export async function prepareGrids(_segments: Segment[], _input: GridInput): Promise<void> {
  throw new Error(ON_THE_MAC.grid)
}
