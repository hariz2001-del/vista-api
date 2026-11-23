import { driveFileId } from './google.ts'

/**
 * What the customer made for each item: the message they wrote, the lettering
 * style they picked, and the design preview the order form rendered.
 *
 * All of it is already in each line's `details` (the row as the source sent
 * it); which cell is which comes from the campaign's column settings, so
 * nothing here knows one campaign's headings. A design-preview cell is read as
 * "label <link>" (how a HYPERLINK cell is kept) or as a bare link.
 */

/** How a lettering style is shown: a Google Fonts family and weight. */
export type MessageStyle = { font: string; weight?: number }

export type LineArtwork = {
  message: string | null
  messageStyle: string | null
  designFileId: string | null
}

export function lineArtwork(details: unknown, columns: Record<string, string> | undefined): LineArtwork {
  const row = (details && typeof details === 'object' ? details : {}) as Record<string, unknown>
  const pick = (key: string) => {
    const heading = columns?.[key]
    const value = heading ? row[heading] : undefined
    return typeof value === 'string' && value.trim() ? value.trim() : null
  }
  const design = pick('design')
  const link = design ? (/<(https?:\/\/[^>\s]+)>$/.exec(design)?.[1] ?? (/^https?:\/\/\S+$/.test(design) ? design : null)) : null
  return { message: pick('message'), messageStyle: pick('messageStyle'), designFileId: driveFileId(link) }
}

/** The campaign's column settings, read defensively from its stored source config. */
export function configColumns(config: unknown): Record<string, string> {
  const columns = (config as { columns?: unknown } | null)?.columns
  return columns && typeof columns === 'object' ? (columns as Record<string, string>) : {}
}

export function configStyles(config: unknown): Record<string, MessageStyle> {
  const styles = (config as { messageStyles?: unknown } | null)?.messageStyles
  return styles && typeof styles === 'object' ? (styles as Record<string, MessageStyle>) : {}
}
