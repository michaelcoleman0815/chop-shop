import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D } from '@napi-rs/canvas'
import { existsSync } from 'fs'
import { join } from 'path'

/**
 * A public post drawn as a card, the way it reads: the author's picture and
 * name, the words, the first picture, the date. Drawn here at the output's
 * own shape, so it can be cut to like any picture, and showing nothing the
 * post does not show to someone logged out.
 */

export interface PostCard {
  displayName: string
  handle: string
  text: string
  avatar: Buffer | null
  image: Buffer | null
  /** ISO time the post was made. */
  createdAt: string | null
  likes: number | null
  reposts: number | null
}

let family: string | null = null

/** The bundled Sora, when the fonts folder has it; the system's sans-serif otherwise. */
function font(fontsDir: string | null): string {
  if (family) return family
  const file = fontsDir ? join(fontsDir, 'Sora.ttf') : null
  family = file && existsSync(file) && GlobalFonts.registerFromPath(file, 'Sora') ? 'Sora' : 'sans-serif'
  return family
}

function rounded(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/** Words to lines no wider than `width`, at most `max` of them, the last cut with an ellipsis. */
export function wrap(ctx: Pick<SKRSContext2D, 'measureText'>, text: string, width: number, max: number): string[] {
  const lines: string[] = []
  for (const para of text.split(/\n+/)) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word
      if (ctx.measureText(next).width <= width || !line) line = next
      else {
        lines.push(line)
        line = word
      }
      if (lines.length >= max) break
    }
    if (line && lines.length < max) lines.push(line)
    if (lines.length >= max) break
  }
  const all = text.split(/\s+/).filter(Boolean).length
  const shown = lines.join(' ').split(/\s+/).filter(Boolean).length
  if (shown < all && lines.length) {
    let last = lines[lines.length - 1]
    while (last && ctx.measureText(`${last}…`).width > width) last = last.slice(0, -1)
    lines[lines.length - 1] = `${last.trimEnd()}…`
  }
  return lines
}

const count = (n: number | null): string | null =>
  n === null ? null : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)

/** The card as a PNG at the output's size: the post on a white card over a soft grey. */
export async function drawPostCard(post: PostCard, size: { width: number; height: number }, fontsDir: string | null): Promise<Buffer> {
  const { width: W, height: H } = size
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  const face = font(fontsDir)
  ctx.fillStyle = '#EEF1F5'
  ctx.fillRect(0, 0, W, H)

  const cardW = Math.round(Math.min(W * 0.86, H * 0.86 * 0.8))
  const unit = cardW / 100
  const pad = 6 * unit
  const inner = cardW - pad * 2
  const nameSize = 4.6 * unit
  const textSize = 5.2 * unit
  const lineGap = textSize * 1.32

  ctx.font = `400 ${textSize}px ${face}`
  const lines = wrap(ctx, post.text, inner, post.image ? 6 : 10)
  const picture = post.image ? await loadImage(post.image).catch(() => null) : null
  const picH = picture ? Math.min(inner * 0.75, (inner / picture.width) * picture.height) : 0
  const avatarD = 11 * unit
  const cardH = pad + avatarD + pad * 0.7 + lines.length * lineGap + (picture ? pad * 0.6 + picH : 0) + pad * 0.9 + nameSize + pad
  const x = Math.round((W - cardW) / 2)
  const y = Math.round(Math.max(pad, (H - cardH) / 2))

  ctx.save()
  ctx.shadowColor = 'rgba(16, 24, 40, 0.16)'
  ctx.shadowBlur = 4 * unit
  ctx.shadowOffsetY = 1.2 * unit
  rounded(ctx, x, y, cardW, cardH, 4 * unit)
  ctx.fillStyle = '#FFFFFF'
  ctx.fill()
  ctx.restore()

  // The author.
  const ax = x + pad
  const ay = y + pad
  ctx.save()
  ctx.beginPath()
  ctx.arc(ax + avatarD / 2, ay + avatarD / 2, avatarD / 2, 0, Math.PI * 2)
  ctx.closePath()
  ctx.clip()
  const avatar = post.avatar ? await loadImage(post.avatar).catch(() => null) : null
  if (avatar) ctx.drawImage(avatar, ax, ay, avatarD, avatarD)
  else {
    ctx.fillStyle = '#1185FE'
    ctx.fillRect(ax, ay, avatarD, avatarD)
    ctx.fillStyle = '#FFFFFF'
    ctx.font = `600 ${avatarD * 0.45}px ${face}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText((post.displayName || post.handle).slice(0, 1).toUpperCase(), ax + avatarD / 2, ay + avatarD / 2)
  }
  ctx.restore()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = '#0F1419'
  ctx.font = `600 ${nameSize}px ${face}`
  const nx = ax + avatarD + pad * 0.5
  const name = wrap(ctx, post.displayName || post.handle, x + cardW - pad - nx, 1)[0] ?? ''
  ctx.fillText(name, nx, ay + avatarD * 0.45)
  ctx.fillStyle = '#536471'
  ctx.font = `400 ${nameSize * 0.85}px ${face}`
  ctx.fillText(wrap(ctx, `@${post.handle}`, x + cardW - pad - nx, 1)[0] ?? '', nx, ay + avatarD * 0.92)

  // The words.
  ctx.fillStyle = '#0F1419'
  ctx.font = `400 ${textSize}px ${face}`
  let ty = ay + avatarD + pad * 0.7 + textSize
  for (const line of lines) {
    ctx.fillText(line, ax, ty)
    ty += lineGap
  }

  // The first picture, whole.
  let by = ty - textSize + lineGap * 0.2
  if (picture) {
    by += pad * 0.4
    const pw = Math.min(inner, (picH / picture.height) * picture.width)
    ctx.save()
    rounded(ctx, ax, by, pw, picH, 2.4 * unit)
    ctx.clip()
    ctx.drawImage(picture, ax, by, pw, picH)
    ctx.restore()
    by += picH
  }

  // When, and how many liked it.
  ctx.fillStyle = '#536471'
  ctx.font = `400 ${nameSize * 0.8}px ${face}`
  const when = post.createdAt ? new Date(post.createdAt) : null
  const date =
    when && Number.isFinite(when.getTime())
      ? when.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
      : null
  const footer = [date, count(post.reposts) ? `${count(post.reposts)} reposts` : null, count(post.likes) ? `${count(post.likes)} likes` : null, 'Bluesky']
    .filter(Boolean)
    .join('  ·  ')
  ctx.fillText(wrap(ctx, footer, inner, 1)[0] ?? '', ax, by + pad * 0.9 + nameSize * 0.8)

  return canvas.encode('png')
}
