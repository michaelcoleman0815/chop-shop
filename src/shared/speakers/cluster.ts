/**
 * Voices grouped into speakers: each stretch of speech has an embedding (a
 * speaker model's fingerprint of the voice), and stretches whose fingerprints
 * point the same way are the same person. Agglomerative clustering on cosine
 * similarity with average linkage: every stretch starts as its own speaker and
 * the two most alike are joined, again and again, until the most alike left
 * are less alike than MERGE_SIMILARITY, or as many speakers as were asked for
 * are left. Then any speaker heard for less than a sliver of the whole is
 * folded into the one it sounds most like: a cough or a laugh is nobody new.
 */

/** Two groups less alike than this, on average, are two people (3D-Speaker CAM++ on clean speech of 1 s or more). */
export const MERGE_SIMILARITY = 0.45
/** A speaker heard for less than this share of the measured speech is folded into the nearest. */
const SLIVER = 0.03
/**
 * A speaker heard for less than this share who sounds at least FOLD_SIMILARITY like a bigger one is that one
 * in another voice: a comic's impressions and quips, a laugh, a shout (6 minutes of a real podcast split one
 * guest into five).
 */
const MINOR = 0.15
const FOLD_SIMILARITY = 0.25

export interface Voiced {
  /** The fingerprint, any length, any scale. */
  embedding: Float32Array
  /** How much speech it stands for, in seconds: what a speaker's share is weighed by. */
  sec: number
}

const unit = (v: Float32Array): Float64Array => {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  return Float64Array.from(v, (x) => x / n)
}

const dot = (a: Float64Array, b: Float64Array): number => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/**
 * Which speaker each stretch is: 0, 1, 2... in order of who is heard first.
 * `speakers`, when known, is how many there are; otherwise the voices decide.
 */
export function clusterVoices(items: Voiced[], opts: { speakers?: number; similarity?: number } = {}): number[] {
  const n = items.length
  if (n === 0) return []
  const want = opts.speakers && opts.speakers > 0 ? Math.min(opts.speakers, n) : 0
  const floor = opts.similarity ?? MERGE_SIMILARITY
  const vecs = items.map((i) => unit(i.embedding))
  // Similarity between every two groups, as the average over their members: at first each stretch is a group,
  // and when two join, the new group's similarity to any other is the two's, weighed by their sizes.
  const sim: Float64Array[] = vecs.map((a) => Float64Array.from(vecs, (b) => dot(a, b)))
  const members: number[][] = items.map((_, i) => [i])
  const alive = new Set(members.map((_, i) => i))
  while (alive.size > 1) {
    let best = -Infinity
    let a = -1
    let b = -1
    for (const x of alive)
      for (const y of alive) {
        if (y <= x) continue
        if (sim[x][y] > best) {
          best = sim[x][y]
          a = x
          b = y
        }
      }
    if (want ? alive.size <= want : best < floor) break
    const na = members[a].length
    const nb = members[b].length
    for (const c of alive) {
      if (c === a || c === b) continue
      const s = (na * sim[a][c] + nb * sim[b][c]) / (na + nb)
      sim[a][c] = s
      sim[c][a] = s
    }
    members[a] = [...members[a], ...members[b]]
    alive.delete(b)
  }
  let groups: number[][] = [...alive].map((k) => members[k])
  const between = (x: number[], y: number[]): number => {
    let s = 0
    for (const i of x) for (const j of y) s += dot(vecs[i], vecs[j])
    return s / (x.length * y.length)
  }
  // A speaker heard for only a sliver goes to the group it is most like, unless a count was asked for.
  const total = items.reduce((s, i) => s + i.sec, 0) || 1
  const weight = (g: number[]): number => g.reduce((s, i) => s + items[i].sec, 0)
  if (!want) {
    let small = groups.filter((g) => weight(g) / total < SLIVER)
    while (small.length > 0 && groups.length > 1) {
      const g = small[0]
      const others = groups.filter((x) => x !== g)
      const home = others.reduce((a, b) => (between(g, a) >= between(g, b) ? a : b))
      groups = groups.filter((x) => x !== g && x !== home).concat([[...home, ...g]])
      small = groups.filter((x) => weight(x) / total < SLIVER)
    }
    // A minor voice that sounds enough like a bigger one is folded into it, the smallest first.
    for (;;) {
      const minor = groups.filter((g) => weight(g) / total < MINOR).sort((a, b) => weight(a) - weight(b))
      const fold = minor
        .map((g) => {
          const bigger = groups.filter((x) => x !== g && weight(x) > weight(g))
          const home = bigger.length ? bigger.reduce((a, b) => (between(g, a) >= between(g, b) ? a : b)) : null
          return home && between(g, home) >= FOLD_SIMILARITY ? { g, home } : null
        })
        .find((f) => f !== null)
      if (!fold) break
      groups = groups.filter((x) => x !== fold.g && x !== fold.home).concat([[...fold.home, ...fold.g]])
    }
  }
  // Named in order of who is heard first.
  const label = new Array<number>(n).fill(0)
  groups
    .map((g) => [...g].sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0])
    .forEach((g, k) => g.forEach((i) => (label[i] = k)))
  return label
}

/** The average fingerprint of each speaker, made unit length: what a short stretch is matched against. */
export function centroids(items: Voiced[], labels: number[]): Float64Array[] {
  const count = labels.length ? Math.max(...labels) + 1 : 0
  return Array.from({ length: count }, (_, k) => {
    const members = items.filter((_, i) => labels[i] === k)
    const dim = members[0]?.embedding.length ?? 0
    const sum = new Float64Array(dim)
    for (const m of members) {
      const u = unit(m.embedding)
      for (let d = 0; d < dim; d++) sum[d] += u[d] * m.sec
    }
    return unit(Float32Array.from(sum))
  })
}

/** Which speaker a fingerprint sounds most like, and how alike. */
export function nearest(embedding: Float32Array, centres: Float64Array[]): { speaker: number; similarity: number } {
  const u = unit(embedding)
  let speaker = 0
  let similarity = -Infinity
  centres.forEach((c, k) => {
    const s = dot(u, c)
    if (s > similarity) {
      similarity = s
      speaker = k
    }
  })
  return { speaker, similarity }
}
