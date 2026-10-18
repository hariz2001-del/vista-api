import opentype from 'opentype.js'
import { INTER_WOFF } from './inter-font.ts'

/**
 * Text for server-made images, drawn as outlines. The hosting has no fonts, so
 * SVG text would come out as empty boxes; outlines from the embedded Inter
 * render the same everywhere.
 */

export type Weight = 400 | 700 | 900

const fonts = new Map<Weight, opentype.Font>()

function font(weight: Weight): opentype.Font {
  let loaded = fonts.get(weight)
  if (!loaded) {
    const bytes = Buffer.from(INTER_WOFF[weight], 'base64')
    loaded = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    fonts.set(weight, loaded)
  }
  return loaded
}

export type TextStyle = { size: number; weight: Weight; fill: string; tracking?: number }

/** Width of a line in pixels. `tracking` is extra space per letter, in em. */
export function measure(text: string, style: TextStyle): number {
  const base = font(style.weight).getAdvanceWidth(text, style.size)
  return base + (style.tracking ?? 0) * style.size * Math.max(0, [...text].length - 1)
}

/** Where the baseline sits for text centred in a line box `lineHeight` tall. */
export function baseline(top: number, lineHeight: number, size: number, weight: Weight = 400): number {
  const f = font(weight)
  const ascent = (f.ascender / f.unitsPerEm) * size
  const descent = (-f.descender / f.unitsPerEm) * size
  return top + (lineHeight - (ascent + descent)) / 2 + ascent
}

/** One line of text as an SVG path, its left edge at x and its baseline at y. */
export function textPath(text: string, x: number, y: number, style: TextStyle): string {
  const f = font(style.weight)
  if (!style.tracking) {
    return `<path fill="${style.fill}" d="${f.getPath(text, x, y, style.size).toPathData(2)}"/>`
  }
  const step = style.tracking * style.size
  let cursor = x
  let d = ''
  for (const char of text) {
    d += f.getPath(char, cursor, y, style.size).toPathData(2)
    cursor += f.getAdvanceWidth(char, style.size) + step
  }
  return `<path fill="${style.fill}" d="${d}"/>`
}

/** Words broken into lines no wider than `width`. A single overlong word keeps its own line. */
export function wrap(text: string, width: number, style: TextStyle): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (line && measure(next, style) > width) {
      lines.push(line)
      line = word
    } else {
      line = next
    }
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}
