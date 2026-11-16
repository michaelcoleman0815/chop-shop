/**
 * A tile of film grain for the preview: grey with every pixel nudged up or
 * down by up to `spread` (0 to 1), evenly, as ffmpeg's uniform noise does.
 * Laid over the picture with overlay blending, mid grey leaves it as it is and
 * the nudges brighten or darken it by about as much as the export's grain.
 */
const made = new Map<number, string>()

export function grainTile(spread: number, size = 160): string {
  const key = Math.round(spread * 1000)
  const hit = made.get(key)
  if (hit) return hit
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const img = ctx.createImageData(size, size)
  const reach = spread * 255
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.round(128 + (Math.random() * 2 - 1) * reach)
    img.data[i] = v
    img.data[i + 1] = v
    img.data[i + 2] = v
    img.data[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  const url = canvas.toDataURL('image/png')
  made.set(key, url)
  return url
}
