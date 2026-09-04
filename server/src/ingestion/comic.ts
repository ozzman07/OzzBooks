import { open, readFile } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'

export interface ComicMetadata {
  /** From ComicInfo.xml's <Title>, else null (caller falls back to filename). */
  title: string | null
  /** ComicInfo.xml's <Series> — a fallback signal only, never wins over the
   * folder-derived series name (see deriveComicSeriesFromSegments below and
   * its call site in scan.ts). */
  seriesFromTag: string | null
  /** ComicInfo.xml's <Number>, falling back to <Volume> when <Number> is
   * absent — real-world taggers use Volume inconsistently as a stand-in for
   * issue number on graphic novels. */
  issueNumberFromTag: number | null
  writer: string | null
  penciller: string | null
  publisher: string | null
  year: number | null
  /** ComicInfo.xml's own <PageCount> claim — informational only. The
   * authoritative page_count stored on the book is always pageCount below,
   * the archive's own natural-sorted image-entry count. */
  pageCountFromTag: number | null
  summary: string | null
  /** Authoritative: count of natural-sorted image entries in the archive. */
  pageCount: number
  /** First page's raw bytes, natural-sorted — pipe through saveArtworkBuffer(). */
  coverBuffer: Buffer | null
}

export function isCbzFile(filename: string): boolean {
  return filename.toLowerCase().endsWith('.cbz')
}

export function isCbrFile(filename: string): boolean {
  return filename.toLowerCase().endsWith('.cbr')
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]) // PK\x03\x04
const RAR_MAGIC = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]) // Rar!\x1a\x07

/**
 * Reads only the first 8 bytes (never the whole file) and classifies the
 * archive by magic bytes rather than trusting its extension — rescues a
 * mislabeled file in either direction (a .cbr-extensioned file that's
 * actually already zip data, or vice versa) before scan.ts decides whether
 * to ingest it or route it to scan_issues.
 */
export async function detectArchiveKind(filePath: string): Promise<'zip' | 'rar' | 'unknown'> {
  const handle = await open(filePath, 'r')
  try {
    const head = Buffer.alloc(8)
    const { bytesRead } = await handle.read(head, 0, 8, 0)
    const bytes = head.subarray(0, bytesRead)
    if (bytes.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) return 'zip'
    if (bytes.subarray(0, RAR_MAGIC.length).equals(RAR_MAGIC)) return 'rar'
    return 'unknown'
  } finally {
    await handle.close()
  }
}

// Splits a name into alternating digit/non-digit runs so digit runs compare
// numerically ("page2" before "page10") while everything else compares
// lexically — the standard natural-sort algorithm. Hand-rolled rather than
// pulling in a package for one function.
const CHUNK_RE = /(\d+)|(\D+)/g
const ALL_DIGITS_RE = /^\d+$/

/** Natural-sort comparator: "page2.jpg" sorts before "page10.jpg". Exported
 * so it's independently unit-testable without needing a real archive. */
export function naturalCompare(a: string, b: string): number {
  const aChunks = a.match(CHUNK_RE) ?? []
  const bChunks = b.match(CHUNK_RE) ?? []
  const len = Math.max(aChunks.length, bChunks.length)
  for (let i = 0; i < len; i++) {
    const ac = aChunks[i]
    const bc = bChunks[i]
    if (ac === undefined) return -1
    if (bc === undefined) return 1
    if (ALL_DIGITS_RE.test(ac) && ALL_DIGITS_RE.test(bc)) {
      const diff = Number(ac) - Number(bc)
      if (diff !== 0) return diff
    } else {
      const cmp = ac.localeCompare(bc)
      if (cmp !== 0) return cmp
    }
  }
  return 0
}

/**
 * First path segment of a comic file's path, relative to the source's
 * path_scope — or null if the file sits directly at the source root with no
 * subfolder at all. Deliberately NOT scan.ts's deriveSeriesFromSegments
 * (the audiobook/ebook penultimate-segment rule with sibling-count
 * disambiguation) — that rule is structurally wrong here. The comics rule
 * is simpler on purpose: first segment, any depth, so
 * "Batman/some-gn.cbz" and "Batman/Elseworlds/some-gn.cbz" both resolve to
 * series "Batman" despite the extra nesting level in the second case.
 */
export function deriveComicSeriesFromSegments(segments: string[]): string | null {
  if (segments.length < 2) return null
  return segments[0] || null
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeXmlEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name])
}

// ComicInfo.xml (the ComicRack/ComicTagger standard) is a flat, single-level
// tag set for every field this parses — per-tag regex extraction is
// consistent with epub.ts's existing minimal-dependency style for this
// exact kind of small embedded XML sidecar, rather than adding a full XML
// parser dependency for one file shape.
function extractTag(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(xml)
  if (!match) return null
  const value = decodeXmlEntities(match[1]).trim()
  return value || null
}

function extractNumberTag(xml: string, tag: string): number | null {
  const raw = extractTag(xml, tag)
  if (raw === null) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

/** Shared with scan.ts's loose-image-folder detection (a folder of
 * extracted-but-never-rezipped pages, no archive at all) — same extension
 * set as the in-archive page detection below, single source of truth. */
export function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())
}

// ComicInfo.xml only counts at the archive root — not searched in
// subfolders — matching the ComicRack/ComicTagger convention. Zip entry
// names use forward slashes regardless of platform, so "no slash" reliably
// means root.
function isRootFile(entryName: string): boolean {
  return !entryName.includes('/')
}

/**
 * Reads a .cbz's embedded ComicInfo.xml (when present) plus its page
 * images: title/series/issue-number/writer/penciller/publisher/year/
 * summary from the tag file, and the authoritative page count + cover
 * (first page, natural-sorted across image entries) straight from the
 * archive's own contents. Missing ComicInfo.xml is not an error — every
 * tag-derived field is simply null, and the archive's images alone still
 * produce a valid pageCount/coverBuffer.
 */
// jszip benchmark (2026-09-02, against real files from /Volumes/Books/Comics):
// two real omnibus .cbz files (74MB and 70MB, both in the "concerning" size
// range the addendum flagged) parsed — full loadAsync + entry list +
// natural sort + cover read — in ~0.1s each once the bytes were on local
// disk. jszip's own overhead is not the bottleneck; a 41-file flat-folder
// scan over the actual SMB-mounted NAS took ~2.5s/file, dominated by
// per-file network round-trips (open/read/close over a contended share),
// not by jszip's in-memory processing. Since ingestion opens each archive
// once per scan (not once per page request, unlike the later page-serving
// route), this is an acceptable cost as-is — no need to switch to a
// streaming reader like yauzl for this step.
export async function readComicMetadata(filePath: string): Promise<ComicMetadata> {
  const buffer = await readFile(filePath)
  const zip = await JSZip.loadAsync(buffer)

  const comicInfoEntry = Object.values(zip.files).find(
    (f) => !f.dir && isRootFile(f.name) && /^comicinfo\.xml$/i.test(f.name),
  )
  const xml = comicInfoEntry ? await comicInfoEntry.async('string') : null

  const imageEntryNames = Object.values(zip.files)
    .filter((f) => !f.dir && isImageFile(f.name))
    .map((f) => f.name)
    .sort(naturalCompare)

  let coverBuffer: Buffer | null = null
  if (imageEntryNames.length > 0) {
    coverBuffer = await zip.files[imageEntryNames[0]].async('nodebuffer')
  } else {
    // Unusual enough (an archive with zero images) to be worth surfacing
    // during real-library validation, but not worth failing the book over —
    // same "missing art doesn't fail the book" precedent as extractArtwork.
    console.warn(`Comic archive has no image entries: ${filePath}`)
  }

  return {
    title: xml ? extractTag(xml, 'Title') : null,
    seriesFromTag: xml ? extractTag(xml, 'Series') : null,
    issueNumberFromTag: xml ? (extractNumberTag(xml, 'Number') ?? extractNumberTag(xml, 'Volume')) : null,
    writer: xml ? extractTag(xml, 'Writer') : null,
    penciller: xml ? extractTag(xml, 'Penciller') : null,
    publisher: xml ? extractTag(xml, 'Publisher') : null,
    year: xml ? extractNumberTag(xml, 'Year') : null,
    pageCountFromTag: xml ? extractNumberTag(xml, 'PageCount') : null,
    summary: xml ? extractTag(xml, 'Summary') : null,
    pageCount: imageEntryNames.length,
    coverBuffer,
  }
}
