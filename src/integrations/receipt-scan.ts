import sharp from 'sharp'

export type Point = { x: number; y: number }

/** Flatten the four visible paper corners; preserve the source separately. */
export async function receiptScan(bytes: Buffer, corners?: Point[]) {
  const { data, info } = await sharp(bytes, { limitInputPixels: 40_000_000 }).rotate().removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
  let image = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
  if (corners) {
    const p = corners.map(({ x, y }) => ({ x: x * (info.width - 1), y: y * (info.height - 1) }))
    const crosses = p.map((point, i) => {
      const next = p[(i + 1) % 4]!, end = p[(i + 2) % 4]!
      return (next.x - point.x) * (end.y - next.y) - (next.y - point.y) * (end.x - next.x)
    })
    if (!crosses.every((value) => value > 0) || Math.abs(p.reduce((sum, point, i) => sum + point.x * p[(i + 1) % 4]!.y - point.y * p[(i + 1) % 4]!.x, 0)) < info.width * info.height * 0.02) throw new Error('Receipt corners must follow the paper clockwise: top-left, top-right, bottom-right, bottom-left.')
    const [tl, tr, br, bl] = p as [Point, Point, Point, Point]
    const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
    const rawWidth = Math.max(distance(tl, tr), distance(bl, br)), rawHeight = Math.max(distance(tl, bl), distance(tr, br))
    const scale = Math.min(1, 1400 / rawWidth, 6000 / rawHeight)
    const width = Math.max(2, Math.round(rawWidth * scale)), height = Math.max(2, Math.round(rawHeight * scale))
    const dx1 = tr.x - br.x, dx2 = bl.x - br.x, dx3 = tl.x - tr.x + br.x - bl.x
    const dy1 = tr.y - br.y, dy2 = bl.y - br.y, dy3 = tl.y - tr.y + br.y - bl.y
    const denominator = dx1 * dy2 - dx2 * dy1
    const g = Math.abs(denominator) < 1e-8 ? 0 : (dx3 * dy2 - dx2 * dy3) / denominator
    const h = Math.abs(denominator) < 1e-8 ? 0 : (dx1 * dy3 - dx3 * dy1) / denominator
    const a = tr.x - tl.x + g * tr.x, b = bl.x - tl.x + h * bl.x
    const d = tr.y - tl.y + g * tr.y, e = bl.y - tl.y + h * bl.y
    const output = Buffer.alloc(width * height * 3)
    for (let y = 0; y < height; y++) {
      const v = y / (height - 1)
      for (let x = 0; x < width; x++) {
        const u = x / (width - 1), k = g * u + h * v + 1
        const sx = Math.max(0, Math.min(info.width - 1, (a * u + b * v + tl.x) / k))
        const sy = Math.max(0, Math.min(info.height - 1, (d * u + e * v + tl.y) / k))
        const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(x0 + 1, info.width - 1), y1 = Math.min(y0 + 1, info.height - 1)
        const fx = sx - x0, fy = sy - y0
        for (let c = 0; c < 3; c++) {
          const at = (ix: number, iy: number) => data[(iy * info.width + ix) * info.channels + c]!
          output[(y * width + x) * 3 + c] = Math.round(at(x0, y0) * (1 - fx) * (1 - fy) + at(x1, y0) * fx * (1 - fy) + at(x0, y1) * (1 - fx) * fy + at(x1, y1) * fx * fy)
        }
      }
    }
    image = sharp(output, { raw: { width, height, channels: 3 } })
  }
  return image.resize({ width: 1400, height: 6000, fit: 'inside', withoutEnlargement: true }).normalise({ lower: 1, upper: 99 }).sharpen().jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer()
}
