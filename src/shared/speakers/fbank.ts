/**
 * Log mel filterbank features, as Kaldi computes them (and torchaudio's
 * compliance.kaldi.fbank, and kaldi-native-fbank): what speaker models such
 * as 3D-Speaker's CAM++ are trained on. 16 kHz sound in frames of 25 ms every
 * 10 ms, each with its DC taken off, pre-emphasised by 0.97, shaped by the
 * Povey window, padded to a 512-point FFT, its power spread over 80
 * triangular bands evenly spaced on the mel scale from 20 Hz to 8 kHz, and
 * logged. Frames run only over whole windows (snip edges), and every band has
 * its mean over the stretch taken off (the models' "global-mean"
 * normalisation), which also makes the scale of the samples not matter.
 */

export const FBANK_RATE = 16000
export const FBANK_BINS = 80
const FRAME = 400
const SHIFT = 160
const FFT = 512
const LOW_HZ = 20
const PREEMPH = 0.97
const FLOOR = 1.1920928955078125e-7

const mel = (hz: number): number => 1127 * Math.log(1 + hz / 700)

/** The Povey window: a Hann window raised to 0.85. */
const WINDOW = Float64Array.from({ length: FRAME }, (_, i) => Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)), 0.85))

/** Each band's weights over the FFT's bins, as Kaldi lays them: [first bin, weights]. */
const BANKS: { from: number; weights: Float64Array }[] = (() => {
  const lo = mel(LOW_HZ)
  const hi = mel(FBANK_RATE / 2)
  const step = (hi - lo) / (FBANK_BINS + 1)
  const banks: { from: number; weights: Float64Array }[] = []
  for (let b = 0; b < FBANK_BINS; b++) {
    const left = lo + b * step
    const centre = left + step
    const right = centre + step
    const w: number[] = []
    let from = -1
    // Kaldi uses the FFT's first half, without the Nyquist bin.
    for (let i = 0; i < FFT / 2; i++) {
      const m = mel((i * FBANK_RATE) / FFT)
      const v = m > left && m < right ? (m <= centre ? (m - left) / (centre - left) : (right - m) / (right - centre)) : 0
      if (v > 0 && from < 0) from = i
      if (from >= 0) w.push(v)
    }
    // Trailing zeros off.
    while (w.length > 0 && w[w.length - 1] === 0) w.pop()
    banks.push({ from: Math.max(0, from), weights: Float64Array.from(w) })
  }
  return banks
})()

/** An in-place radix-2 FFT of FFT points. */
const REV = Uint16Array.from({ length: FFT }, (_, i) => {
  let r = 0
  for (let b = 0, x = i; b < Math.log2(FFT); b++, x >>= 1) r = (r << 1) | (x & 1)
  return r
})
const COS = Float64Array.from({ length: FFT / 2 }, (_, i) => Math.cos((-2 * Math.PI * i) / FFT))
const SIN = Float64Array.from({ length: FFT / 2 }, (_, i) => Math.sin((-2 * Math.PI * i) / FFT))

function fft(re: Float64Array, im: Float64Array): void {
  for (let i = 0; i < FFT; i++) {
    const j = REV[i]
    if (j > i) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let size = 2; size <= FFT; size <<= 1) {
    const half = size >> 1
    const step = FFT / size
    for (let start = 0; start < FFT; start += size) {
      for (let k = 0; k < half; k++) {
        const c = COS[k * step]
        const s = SIN[k * step]
        const a = start + k
        const b = a + half
        const tr = re[b] * c - im[b] * s
        const ti = re[b] * s + im[b] * c
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
      }
    }
  }
}

/** How many frames a stretch of `samples` makes. */
export function fbankFrames(samples: number): number {
  return samples < FRAME ? 0 : 1 + Math.floor((samples - FRAME) / SHIFT)
}

/**
 * The features of a stretch of 16 kHz sound: frames x FBANK_BINS, row after
 * row, with each band's mean taken off. Empty when it is shorter than a frame.
 */
export function fbank(samples: Float32Array): { frames: number; data: Float32Array } {
  const frames = fbankFrames(samples.length)
  const data = new Float32Array(frames * FBANK_BINS)
  const re = new Float64Array(FFT)
  const im = new Float64Array(FFT)
  const power = new Float64Array(FFT / 2)
  for (let f = 0; f < frames; f++) {
    const at = f * SHIFT
    let mean = 0
    for (let i = 0; i < FRAME; i++) mean += samples[at + i]
    mean /= FRAME
    re.fill(0)
    im.fill(0)
    for (let i = 0; i < FRAME; i++) re[i] = samples[at + i] - mean
    // Pre-emphasis from the end back, the first sample against itself.
    for (let i = FRAME - 1; i > 0; i--) re[i] -= PREEMPH * re[i - 1]
    re[0] -= PREEMPH * re[0]
    for (let i = 0; i < FRAME; i++) re[i] *= WINDOW[i]
    fft(re, im)
    for (let i = 0; i < FFT / 2; i++) power[i] = re[i] * re[i] + im[i] * im[i]
    for (let b = 0; b < FBANK_BINS; b++) {
      const { from, weights } = BANKS[b]
      let e = 0
      for (let i = 0; i < weights.length; i++) e += weights[i] * power[from + i]
      data[f * FBANK_BINS + b] = Math.log(Math.max(e, FLOOR))
    }
  }
  // Each band's mean over the stretch off.
  if (frames > 0) {
    for (let b = 0; b < FBANK_BINS; b++) {
      let m = 0
      for (let f = 0; f < frames; f++) m += data[f * FBANK_BINS + b]
      m /= frames
      for (let f = 0; f < frames; f++) data[f * FBANK_BINS + b] -= m
    }
  }
  return { frames, data }
}
