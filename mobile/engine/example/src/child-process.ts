/**
 * Stands in for Node's child_process, which src/main/intake.ts imports for
 * the Mac. The self-test only uses its readProbe, which spawns nothing.
 */
export function spawn(): never {
  throw new Error('There are no child processes on the phone: run tools through the engine plugin.')
}
