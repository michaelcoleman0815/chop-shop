// Draws the site's own shapes from simple maths, so none of them is artwork from anywhere else:
// the living mark's two iridescent layers, the scalloped sticker, and three avatar shapes for the brand tile.
// The files it writes are committed; run it only to redraw them.
//
//   node scripts/shapes.mjs

import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'src', 'img')
const f = (n) => +n.toFixed(2)

// A closed smooth path through points on r(θ), as cubic Béziers (Catmull-Rom).
function smooth(points) {
  const n = points.length
  let d = `M${f(points[0][0])} ${f(points[0][1])}`
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n], p1 = points[i], p2 = points[(i + 1) % n], p3 = points[(i + 2) % n]
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += ` C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`
  }
  return d + 'Z'
}
const polar = (cx, cy, r, steps, phase = 0) =>
  Array.from({ length: steps }, (_, i) => {
    const t = (i / steps) * Math.PI * 2 + phase
    return [cx + r(t) * Math.cos(t), cy + r(t) * Math.sin(t)]
  })

// The living mark: a soft seven-lobed blob, filled with drifting pastel light and blurred at the edge.
// Two layers with the light in different places; the page turns them past each other and lets it breathe.
const star = smooth(polar(100, 100, (t) => 62 * (1 + 0.13 * Math.cos(7 * t) + 0.04 * Math.cos(3 * t + 1)), 56, 0.2))
const living = (id, spots) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
<defs>
<clipPath id="s${id}"><path d="${star}"/></clipPath>
<filter id="b${id}" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="5.5"/></filter>
${spots.map(([, , , c], i) => `<radialGradient id="g${id}${i}"><stop offset="0" stop-color="${c}"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`).join('')}
</defs>
<g filter="url(#b${id})"><g clip-path="url(#s${id})">
<rect width="200" height="200" fill="#e8dcf6"/>
${spots.map(([x, y, r], i) => `<circle cx="${x}" cy="${y}" r="${r}" fill="url(#g${id}${i})"/>`).join('')}
</g></g>
</svg>
`
writeFileSync(join(OUT, 'living-a.svg'), living('a', [
  [70, 70, 70, '#f294c4'], [140, 80, 66, '#a993f2'], [120, 145, 70, '#8acdf4'], [60, 140, 60, '#93e4c6'], [100, 100, 46, '#fff4fb']
]))
writeFileSync(join(OUT, 'living-b.svg'), living('b', [
  [130, 60, 70, '#f7d084'], [60, 90, 64, '#8ab9f5'], [100, 150, 70, '#f094bb'], [150, 130, 58, '#a2eacf'], [96, 96, 44, '#fbf7ff']
]))

// Shapes used as masks, so the page colours them: a sticker with fourteen soft scallops, and three avatar shapes.
const shapes = {
  scallop: smooth(polar(50, 50, (t) => 46 * (1 + 0.055 * Math.cos(14 * t)), 56)),
  'shape-blob': smooth(polar(50, 50, (t) => 40 * (1 + 0.07 * Math.cos(3 * t + 0.6) + 0.04 * Math.cos(5 * t)), 24)),
  'shape-flower': smooth(polar(50, 50, (t) => 41 * (1 + 0.12 * Math.cos(6 * t)), 48)),
  'shape-soft': smooth(polar(50, 50, (t) => 39 / Math.pow(Math.pow(Math.abs(Math.cos(t)), 4) + Math.pow(Math.abs(Math.sin(t)), 4), 0.25), 32, Math.PI / 4))
}
for (const [name, d] of Object.entries(shapes)) {
  writeFileSync(join(OUT, `${name}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="${d}"/></svg>\n`)
}

// The crew (docs: the owner's crew notes): six simple blobs with two eye marks, one per real job, coloured by the
// page (--crew-*), so each is a partial the page can colour, move and reuse. Shapes from the notes:
// Echo soft and wave-edged, Snip crisp and a little star-cornered, Quill a leaf, Scout round with an antenna nub,
// Tint a scalloped badge, Reel a pill.
const PARTIALS = join(OUT, '..', 'partials')
const eyes = (cx, cy, gap = 10) =>
  `<g class="crew-eyes"><ellipse cx="${f(cx - gap)}" cy="${f(cy)}" rx="3.6" ry="5"/><ellipse cx="${f(cx + gap)}" cy="${f(cy)}" rx="3.6" ry="5"/></g>`
const starPoints = (cx, cy, outer, inner, points, phase) =>
  Array.from({ length: points * 2 }, (_, i) => {
    const r = i % 2 ? inner : outer
    const t = (i / (points * 2)) * Math.PI * 2 + phase
    return `${f(cx + r * Math.cos(t))} ${f(cy + r * Math.sin(t))}`
  })
const crew = {
  echo: `<path class="crew-body" d="${smooth(polar(50, 54, (t) => 37 * (1 + 0.045 * Math.cos(9 * t)), 72))}"/>${eyes(50, 50)}`,
  snip: `<path class="crew-body crew-crisp" d="M${starPoints(50, 54, 41, 30, 5, -Math.PI / 2).join(' L')}Z"/>${eyes(50, 52, 9)}`,
  quill: `<g transform="rotate(-24 50 50)"><path class="crew-body" d="M50 9 C80 25 86 64 50 92 C14 64 20 25 50 9Z"/><path class="crew-vein" d="M50 17 C50.6 23 50.6 29 50 35"/></g>${eyes(48, 52, 9)}`,
  scout: `<path class="crew-antenna" d="M50 24 C50 16 54 12 60 9"/><circle class="crew-body" cx="61" cy="8" r="5"/><circle class="crew-body" cx="50" cy="58" r="35"/>${eyes(50, 54)}`,
  tint: `<path class="crew-body" d="${smooth(polar(50, 52, (t) => 38 * (1 + 0.08 * Math.cos(10 * t)), 80))}"/>${eyes(50, 50)}`,
  reel: `<rect class="crew-body" x="14" y="30" width="72" height="46" rx="23"/><circle class="crew-spot" cx="28" cy="38" r="2.6"/><circle class="crew-spot" cx="72" cy="38" r="2.6"/>${eyes(50, 52)}`
}
for (const [id, body] of Object.entries(crew)) {
  writeFileSync(
    join(PARTIALS, `crew-${id}.html`),
    `<svg class="crew crew-${id}" viewBox="0 0 100 100" aria-hidden="true" focusable="false">${body}</svg>`
  )
}
console.log('wrote living-a.svg, living-b.svg, scallop.svg, shape-blob.svg, shape-flower.svg, shape-soft.svg and the six crew partials')
