import { dimMatrix, FILL_TRUST } from './pixels'
import { scaled, type FxStep } from './effects'

/**
 * A plan's picture program as ffmpeg filters, for the export's final pass.
 *
 * Each effect is a pass over the stretch of frames it covers: the picture
 * is split, the stretch cut out by frame number and run through the
 * program on planar RGB (gbrp), and the three pieces joined again, so the
 * frames either side pass through untouched and nothing outside the stretch
 * costs anything. Masks and shift maps come in as files the export drew
 * frame by frame (main/fx-render): lossless FFV1 in gbrp, a mask grey in all
 * three planes, a shift map with the across shift in red and the down shift
 * in green, each 128 for none.
 *
 * Only filters the phone's LGPL ffmpeg 6.0 has: split, trim, setpts,
 * format, concat, gblur, colorchannelmixer, lut, lut2, maskedmerge,
 * shuffleplanes and displace. Every one has its JavaScript twin in
 * fx/pixels, checked against ffmpeg 6.0, 6.1 and 7.0.
 */

export interface FxPass {
  /** The frames it covers on the output clock: from `startFrame`, up to but not including `endFrame`. */
  startFrame: number
  endFrame: number
  program: FxStep[]
  /** The files of its masks and shift maps, in the order the program names them. */
  masks: string[]
  shifts: string[]
  /** The working size over the design size. */
  k: number
}

const n3 = (v: number): string => Number(v.toFixed(5)).toString()

/**
 * Frames stamped by their count on the output's clock. Files written frame
 * by frame come back with their container's own stamps (Matroska keeps
 * milliseconds, so 66.7 ms reads back as 67), and with the picture split
 * and joined around an effect, maskedmerge and displace then paired a frame
 * with the wrong mask, two masks to every three frames. By count, frame n
 * meets mask n.
 */
const counted = (fps: number): string => `settb=1/${fps},setpts=N/(${fps}*TB)`

/** A lut2 or lut expression for every plane: the planes of a mask are all the same. */
const allPlanes = (expr: string): string => `c0='${expr}':c1='${expr}':c2='${expr}'`

/**
 * The chains for every pass, one after another over the picture `input`,
 * and the label they end on. `addInput` adds a file as an input and says its
 * number. Passes may overlap: each runs on what the one before left.
 */
/**
 * How the picture goes into planar RGB and back, and an overlay into YUV. The
 * export says BT.709 at every step (main/cut-render TO_RGB, TO_YUV, TO_YUVA),
 * the RGB the preview reads the picture in; left out, ffmpeg's own choice.
 */
export interface FxColour {
  toRgb: string
  toYuv: string
  toYuva: string
}

const AS_IS: FxColour = { toRgb: 'format=gbrp', toYuv: 'format=yuv420p', toYuva: 'format=yuva420p' }

export function pictureFxChains(
  passes: FxPass[],
  input: string,
  addInput: (path: string) => number,
  fps: number,
  totalFrames: number,
  colour: FxColour = AS_IS
): { chains: string[]; out: string } {
  const chains: string[] = []
  let current = input
  passes.forEach((pass, n) => {
    const start = Math.max(0, Math.min(totalFrames, pass.startFrame))
    const end = Math.max(start, Math.min(totalFrames, pass.endFrame))
    if (end - start < 1 || pass.program.length === 0) return
    const p = `fx${n}`
    const before = start > 0
    const after = end < totalFrames
    const pieces = 1 + (before ? 1 : 0) + (after ? 1 : 0)
    if (pieces > 1) chains.push(`[${current}]split=${pieces}${before ? `[${p}a]` : ''}[${p}b]${after ? `[${p}c]` : ''}`)
    const mid = pieces > 1 ? `${p}b` : current
    if (before) chains.push(`[${p}a]trim=end_frame=${start},setpts=PTS-STARTPTS,setsar=1[${p}pre]`)
    if (after) chains.push(`[${p}c]trim=start_frame=${end},setpts=PTS-STARTPTS,setsar=1[${p}post]`)
    // Stamped by count, as the masks are: each frame meets the mask drawn for it.
    chains.push(`[${mid}]trim=start_frame=${start}:end_frame=${end},${counted(fps)},${colour.toRgb}[${p}_pic]`)
    const masks = pass.masks.map((path) => addInput(path))
    const shifts = pass.shifts.map((path) => addInput(path))
    const out = programChains(pass.program, p, masks, shifts, pass.k, chains, fps)
    chains.push(`[${out}]${colour.toYuv},setsar=1[${p}mid]`)
    const parts = [before ? `[${p}pre]` : '', `[${p}mid]`, after ? `[${p}post]` : ''].join('')
    // Joined and stamped again by count, so every frame is exactly where it was.
    chains.push(
      pieces > 1
        ? `${parts}concat=n=${pieces}:v=1:a=0,settb=1/${fps},setpts=N/(${fps}*TB)[${p}v]`
        : `[${p}mid]settb=1/${fps},setpts=N/(${fps}*TB)[${p}v]`
    )
    current = `${p}v`
  })
  return { chains, out: current }
}

/**
 * The program's steps as chains on labelled pictures, starting from
 * `${p}_pic`: every picture, mask and map split as many times as it is read.
 * Returns the label of the picture it ends on.
 */
export function programChains(
  program: FxStep[],
  p: string,
  maskInputs: number[],
  shiftInputs: number[],
  k: number,
  chains: string[],
  fps = 30
): string {
  // How many times each picture, mask and map is read.
  const reads = new Map<string, number>()
  const read = (name: string): void => {
    reads.set(name, (reads.get(name) ?? 0) + 1)
  }
  for (const s of program) {
    if (s.op === 'merge') {
      read(`pic:${s.base}`)
      read(`pic:${s.over}`)
      read(`mask:${s.mask}`)
    } else if (s.op === 'fill') {
      read(`pic:${s.from}`)
      read(`mask:${s.keep}`)
    } else if (s.op === 'displace') {
      read(`pic:${s.from}`)
      read(`shift:${s.shift}`)
    } else read(`pic:${s.from}`)
  }
  // Each read takes the next copy of what it reads.
  const copies = new Map<string, string[]>()
  const provide = (key: string, label: string): void => {
    const n = reads.get(key) ?? 0
    if (n <= 1) {
      copies.set(key, [label])
      return
    }
    const names = Array.from({ length: n }, (_, i) => `${label}_${i}`)
    chains.push(`[${label}]split=${n}${names.map((x) => `[${x}]`).join('')}`)
    copies.set(key, names)
  }
  const take = (key: string): string => {
    const list = copies.get(key)
    const next = list?.shift()
    if (!next) throw new Error(`The effect's program reads ${key} before it is made.`)
    return next
  }
  provide('pic:pic', `${p}_pic`)
  maskInputs.forEach((input, i) => {
    if (!reads.has(`mask:${i}`)) return
    chains.push(`[${input}:v]${counted(fps)},format=gbrp[${p}_m${i}]`)
    provide(`mask:${i}`, `${p}_m${i}`)
  })
  shiftInputs.forEach((input, i) => {
    if (!reads.has(`shift:${i}`)) return
    chains.push(`[${input}:v]${counted(fps)},format=gbrp[${p}_s${i}]`)
    provide(`shift:${i}`, `${p}_s${i}`)
  })
  let last = `${p}_pic`
  program.forEach((s, j) => {
    const to = `${p}_${s.to}`
    const q = `${p}_${j}`
    switch (s.op) {
      case 'blur':
        chains.push(
          `[${take(`pic:${s.from}`)}]gblur=sigma=${scaled(s.sigma, k)}:sigmaV=${s.sigmaV > 0 ? scaled(s.sigmaV, k) : 0}:steps=${s.steps}[${to}]`
        )
        break
      case 'dim': {
        const m = dimMatrix(s.level, s.grey)
        const names = ['rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb']
        chains.push(
          `[${take(`pic:${s.from}`)}]colorchannelmixer=${names.map((x, i) => `${x}=${n3(m[i])}`).join(':')}[${to}]`
        )
        break
      }
      case 'merge':
        chains.push(`[${take(`pic:${s.base}`)}][${take(`pic:${s.over}`)}][${take(`mask:${s.mask}`)}]maskedmerge[${to}]`)
        break
      case 'displace': {
        const map = take(`shift:${s.shift}`)
        chains.push(`[${map}]split=2[${q}sa][${q}sb]`)
        // Red holds the shift across, green the shift down: each spread to every plane.
        chains.push(`[${q}sa]shuffleplanes=map0=2:map1=2:map2=2[${q}x]`)
        chains.push(`[${q}sb]shuffleplanes=map0=0:map1=0:map2=0[${q}y]`)
        chains.push(`[${take(`pic:${s.from}`)}][${q}x][${q}y]displace=edge=${s.edge}[${to}]`)
        break
      }
      case 'fill': {
        // Normalized convolution at two sizes (fx/pixels fillHoles).
        const near = scaled(s.near, k)
        const far = scaled(s.far, k)
        chains.push(`[${take(`mask:${s.keep}`)}]split=3[${q}k0][${q}k1][${q}k2]`)
        chains.push(`[${take(`pic:${s.from}`)}][${q}k0]lut2=${allPlanes('x*y/255')},split=2[${q}q0][${q}q1]`)
        chains.push(`[${q}q0]gblur=sigma=${near}:sigmaV=${near}:steps=${s.steps}[${q}qn]`)
        chains.push(`[${q}q1]gblur=sigma=${far}:sigmaV=${far}:steps=${s.steps}[${q}qf]`)
        chains.push(`[${q}k1]gblur=sigma=${near}:sigmaV=${near}:steps=${s.steps},split=2[${q}kn0][${q}kn1]`)
        chains.push(`[${q}k2]gblur=sigma=${far}:sigmaV=${far}:steps=${s.steps}[${q}kf]`)
        const divide = allPlanes('if(gt(y\\,0)\\,min(255\\,x*255/y)\\,0)')
        chains.push(`[${q}qn][${q}kn0]lut2=${divide}[${q}fn]`)
        chains.push(`[${q}qf][${q}kf]lut2=${divide}[${q}ff]`)
        const { lo, hi } = FILL_TRUST
        chains.push(`[${q}kn1]lut=${allPlanes(`clip((val-${lo})*255/${hi - lo}\\,0\\,255)`)}[${q}trust]`)
        chains.push(`[${q}ff][${q}fn][${q}trust]maskedmerge[${to}]`)
        break
      }
    }
    provide(`pic:${s.to}`, to)
    last = to
  })
  return last
}

export interface FxOverlayFile {
  path: string
  /** The output frame it starts on. */
  startFrame: number
}

/** Overlays with alpha laid over the picture from their frames on, each frame stamped by its count. */
export function overlayChains(
  overlays: FxOverlayFile[],
  input: string,
  addInput: (path: string) => number,
  fps: number,
  colour: FxColour = AS_IS
): { chains: string[]; out: string } {
  const chains: string[] = []
  let current = input
  overlays.forEach((o, i) => {
    const k = addInput(o.path)
    // Drawn in RGB; into YUV before it meets the picture, as the graphics go, so a ring's colour stays itself.
    chains.push(`[${k}:v]${colour.toYuva},settb=1/${fps},setpts=(N+${o.startFrame})/(${fps}*TB)[fxo${i}]`)
    chains.push(`[${current}][fxo${i}]overlay=0:0:eof_action=pass[fxov${i}]`)
    current = `fxov${i}`
  })
  return { chains, out: current }
}
