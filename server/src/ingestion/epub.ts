import path from 'node:path'
import EPub from 'epub'

export interface EpubMetadata {
  title: string
  author: string | null
  /** Raw cover image bytes, if the epub's manifest/metadata point at one — pass to saveArtworkBuffer() to resize+save. */
  coverBuffer: Buffer | null
  hasDrm: boolean
  /** Raw <dc:subject> tags straight from the OPF, e.g. "Fiction, science
   * fiction, general" — free text, no fixed vocabulary. Feed to
   * mapToControlledGenre() (enrichment/genreOptions.ts) rather than storing
   * or displaying directly; quality varies wildly by how the file was
   * produced (see readEpubMetadata's doc comment). */
  subjects: string[] | null
}

// Extensions covered by embedded-font obfuscation (Adobe's font-mangling
// algorithm and the IDPF's lighter one) — required by font licenses, not
// DRM, and leaves the book's actual text completely unencrypted/readable.
const FONT_EXTENSIONS = new Set(['.otf', '.ttf', '.woff', '.woff2', '.pfb', '.dfont'])

// The `epub` package's own hasDRM() just checks whether META-INF/
// encryption.xml exists at all, which false-positives on the very common
// case of a book that only obfuscates its embedded fonts (real-world
// epubs from calibre/most conversion tools do this whenever they embed a
// custom font, unrelated to actual reader restrictions) — every book we
// saw flagged during real-library testing turned out to be this case, not
// genuine DRM. Real DRM encrypts actual content files (the .xhtml/.html
// spine, not just fonts), so only flag it as DRM if some *other* file is
// listed as encrypted. Extension alone isn't quite enough — some tools
// store an obfuscated font under a generic extension like .dat — so also
// treat anything sitting in a folder named "fonts" as font-like; a real
// content file never lives there.
function looksLikeFont(uri: string): boolean {
  if (FONT_EXTENSIONS.has(path.extname(uri).toLowerCase())) return true
  return path.dirname(uri).toLowerCase().split('/').some((segment) => segment === 'fonts' || segment === 'font')
}

async function hasContentDrm(epub: EPub): Promise<boolean> {
  const entry = epub.zip.file('META-INF/encryption.xml')
  if (!entry) return false
  const xml = await entry.async('string')
  const references = [...xml.matchAll(/CipherReference[^>]*URI="([^"]+)"/g)].map((m) => m[1])
  return references.some((uri) => !looksLikeFont(uri))
}

// EPUB2 and EPUB3 point at their cover image two different ways: EPUB2 via
// an OPF <meta name="cover" content="MANIFEST_ID"/> (which the epub package
// surfaces as metadata.cover — see its _parseMetadata), EPUB3 via a
// manifest <item properties="cover-image" .../> — check both, since either
// can appear regardless of which the file otherwise looks like.
function findCoverManifestId(epub: EPub): string | undefined {
  if (typeof epub.metadata.cover === 'string' && epub.metadata.cover) return epub.metadata.cover
  const item = Object.values(epub.manifest).find(
    (m) => typeof m.properties === 'string' && m.properties.includes('cover-image'),
  )
  return item?.id
}

/**
 * Reads title/author/cover from an epub file's own OPF metadata — the
 * ebook-only-book ('format' = 'epub') equivalent of music-metadata's tag
 * parsing for audio files. DRM-encumbered epubs are flagged via hasDrm
 * (same "skip, don't fail the whole scan" treatment as a DRM-encumbered
 * .aax audio file elsewhere in ingestion — see BACKUP_FOLDER_RE's
 * neighbors in scan.ts) rather than thrown, leaving the actual skip
 * decision to the caller.
 */
export async function readEpubMetadata(filePath: string): Promise<EpubMetadata> {
  const epub = new EPub(filePath)
  await epub.parse()

  let coverBuffer: Buffer | null = null
  const coverId = findCoverManifestId(epub)
  if (coverId) {
    try {
      coverBuffer = (await epub.getImage(coverId)).data
    } catch (err) {
      console.warn(`Skipping unreadable cover image in epub ${filePath}:`, err)
    }
  }

  return {
    // Same filename fallback as m4b.ts/mp3Folder.ts when the tag/metadata
    // is missing — a real (if imperfect) title beats a generic placeholder.
    title: epub.metadata.title?.trim() || path.basename(filePath, path.extname(filePath)),
    author: epub.metadata.creator?.trim() || null,
    coverBuffer,
    hasDrm: await hasContentDrm(epub),
    subjects: epub.metadata.subjects?.filter((s) => s.trim()).map((s) => s.trim()) || null,
  }
}
