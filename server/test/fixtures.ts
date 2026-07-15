import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface TestLibrary {
  root: string
  mp3FolderDir: string
  m4bPath: string
  drmPath: string
  corruptM4bPath: string
  splitBookDir: string
  splitBookPart1: string
  splitBookPart2: string
  genericBookPart1: string
  genericBookPart2: string
  folderAuthorBookPath: string
  garbledFolderBookPath: string
  mixedFolderLooseBookPath: string
  mixedFolderNestedBookPath: string
  sourceBackupFilePath: string
  legitimateSourceTitleBookPath: string
  toDeleteBookPath: string
  toDeleteBackupFilePath: string
  corruptCoverBookPath: string
}

async function makeTone(outPath: string, durationSeconds: number, extraArgs: string[] = []) {
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=220:duration=${durationSeconds}`,
    ...extraArgs,
    outPath,
  ])
}

/**
 * Builds a real (tiny) MP3-folder book and a real M4B book with embedded
 * chapters, using ffmpeg — so ingestion is tested against actual valid
 * audio containers rather than hand-waved fixtures.
 */
export async function buildTestLibrary(): Promise<TestLibrary> {
  const root = await mkdtemp(path.join(tmpdir(), 'ozzbooks-test-'))

  // --- MP3-folder book: three standalone chapter files ---
  const mp3FolderDir = path.join(root, 'Andy Weir', 'Project Hail Mary')
  await mkdir(mp3FolderDir, { recursive: true })
  const mp3Chapters = [
    { file: '01 - Chapter One.mp3', track: 1, title: 'Chapter One' },
    { file: '02 - Chapter Two.mp3', track: 2, title: 'Chapter Two' },
    { file: '03 - Chapter Three.mp3', track: 3, title: 'Chapter Three' },
  ]
  for (const ch of mp3Chapters) {
    await makeTone(path.join(mp3FolderDir, ch.file), 1, [
      '-metadata',
      `title=${ch.title}`,
      '-metadata',
      'album=Project Hail Mary',
      '-metadata',
      'artist=Andy Weir',
      '-metadata',
      `track=${ch.track}`,
      '-c:a',
      'libmp3lame',
    ])
  }

  // Scratch dir for intermediate ffmpeg build artifacts — kept outside
  // `root` so it never leaks into the library tree being scanned.
  const scratchDir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-scratch-'))

  // --- M4B book with two embedded chapters ---
  const m4bDir = path.join(root, 'Brandon Sanderson', 'Mistborn')
  await mkdir(m4bDir, { recursive: true })
  const m4bPath = path.join(m4bDir, 'Mistborn.m4b')
  const rawM4b = path.join(scratchDir, '_raw.m4b')
  await makeTone(rawM4b, 4, ['-metadata', 'title=Mistborn: The Final Empire', '-metadata', 'artist=Brandon Sanderson', '-c:a', 'aac'])

  const chapterMetaPath = path.join(scratchDir, 'chapters.txt')
  await writeFile(
    chapterMetaPath,
    [
      ';FFMETADATA1',
      'title=Mistborn: The Final Empire',
      'artist=Brandon Sanderson',
      '',
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      'START=0',
      'END=2000',
      'title=Prologue',
      '',
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      'START=2000',
      'END=4000',
      'title=Chapter One',
      '',
    ].join('\n'),
  )

  await execFileAsync('ffmpeg', [
    '-y',
    '-i',
    rawM4b,
    '-i',
    chapterMetaPath,
    '-map_metadata',
    '1',
    '-codec',
    'copy',
    m4bPath,
  ])

  // --- DRM file that must be skipped ---
  const drmDir = path.join(root, 'Some Author', 'Audible Book')
  await mkdir(drmDir, { recursive: true })
  const drmPath = path.join(drmDir, 'book.aax')
  await writeFile(drmPath, Buffer.from('not a real aax, ingestion should never read this'))

  // --- Book split across two M4B files ("Part 1"/"Part 2"), each with its
  // own embedded chapter — must ingest as ONE book with both chapters,
  // not two separate books ---
  const splitBookDir = path.join(root, 'Some Author', 'Split Book')
  await mkdir(splitBookDir, { recursive: true })
  const splitBookPart1 = path.join(splitBookDir, 'Split Book, Part 1.m4b')
  const splitBookPart2 = path.join(splitBookDir, 'Split Book, Part 2.m4b')

  async function buildPart(outPath: string, title: string, chapterTitle: string) {
    const raw = path.join(scratchDir, `_raw_${path.basename(outPath)}`)
    await makeTone(raw, 2, ['-metadata', `title=${title}`, '-metadata', 'artist=Some Author', '-c:a', 'aac'])
    const chapterMeta = path.join(scratchDir, `_chapters_${path.basename(outPath)}.txt`)
    await writeFile(
      chapterMeta,
      [
        ';FFMETADATA1',
        `title=${title}`,
        'artist=Some Author',
        '',
        '[CHAPTER]',
        'TIMEBASE=1/1000',
        'START=0',
        'END=2000',
        `title=${chapterTitle}`,
        '',
      ].join('\n'),
    )
    await execFileAsync('ffmpeg', ['-y', '-i', raw, '-i', chapterMeta, '-map_metadata', '1', '-codec', 'copy', outPath])
  }

  await buildPart(splitBookPart1, 'Split Book, Part 1', 'Prologue')
  await buildPart(splitBookPart2, 'Split Book, Part 2', 'Epilogue')

  // --- Split book where each part's own embedded chapter is a generic,
  // auto-numbered label ("Part 1" in both files, restarting per file) —
  // reproduces the real-world "Before They Are Hanged" case where
  // prefixing with our own part label would produce "Part 1: Part 1" ---
  const genericBookDir = path.join(root, 'Some Author', 'Generic Chapters Book')
  await mkdir(genericBookDir, { recursive: true })
  const genericBookPart1 = path.join(genericBookDir, 'Generic Chapters Book, Part 1.m4b')
  const genericBookPart2 = path.join(genericBookDir, 'Generic Chapters Book, Part 2.m4b')
  await buildPart(genericBookPart1, 'Generic Chapters Book, Part 1', 'Part 1')
  await buildPart(genericBookPart2, 'Generic Chapters Book, Part 2', 'Part 1')

  // --- Author-folder-derived author: folder name should win over a
  // deliberately mismatched embedded tag, since the user organizes the NAS
  // by one folder per author and that's more consistent than tags ---
  const folderAuthorDir = path.join(root, 'Real Folder Author, Name', 'Folder Author Test Book')
  await mkdir(folderAuthorDir, { recursive: true })
  const folderAuthorBookPath = path.join(folderAuthorDir, 'book.m4b')
  await makeTone(folderAuthorBookPath, 1, [
    '-metadata',
    'title=Folder Author Test Book',
    '-metadata',
    'artist=Wrong Tag Author',
    '-c:a',
    'aac',
  ])

  // --- Garbled 8.3-style folder name (e.g. "WO3RF0~1", seen on the real
  // NAS from some historical file transfer) — not a trustworthy author
  // name, so this must fall back to the embedded tag instead ---
  const garbledFolderDir = path.join(root, 'ABC123~1', 'Garbled Folder Test Book')
  await mkdir(garbledFolderDir, { recursive: true })
  const garbledFolderBookPath = path.join(garbledFolderDir, 'book.m4b')
  await makeTone(garbledFolderBookPath, 1, [
    '-metadata',
    'title=Garbled Folder Test Book',
    '-metadata',
    'artist=Fallback Tag Author',
    '-c:a',
    'aac',
  ])

  // --- Mixed folder: a loose standalone .m4b sitting directly alongside a
  // subdirectory that's itself a full book — reproduces the real "Dresden
  // Files" bug where a folder's own short-story file caused the scanner to
  // treat it as a leaf and silently skip every sibling book subfolder ---
  const seriesDir = path.join(root, 'Series Author', 'The Series')
  await mkdir(seriesDir, { recursive: true })
  const mixedFolderLooseBookPath = path.join(seriesDir, 'Standalone Short Story.m4b')
  await makeTone(mixedFolderLooseBookPath, 1, [
    '-metadata',
    'title=Standalone Short Story',
    '-metadata',
    'artist=Series Author',
    '-c:a',
    'aac',
  ])
  const nestedBookDir = path.join(seriesDir, 'The Series 01 - Book One')
  await mkdir(nestedBookDir, { recursive: true })
  const mixedFolderNestedBookPath = path.join(nestedBookDir, 'book.m4b')
  await makeTone(mixedFolderNestedBookPath, 1, [
    '-metadata',
    'title=The Series 01 - Book One',
    '-metadata',
    'artist=Series Author',
    '-c:a',
    'aac',
  ])

  // --- "zzzSource files" backup folder — the endorsed naming convention
  // going forward (existing "Source"/"source files"/etc folders are being
  // renamed to this over time) — original files kept just in case, must
  // never be ingested (would otherwise show as a duplicate) ---
  const sourceBackupDir = path.join(seriesDir, 'zzzSource files')
  await mkdir(sourceBackupDir, { recursive: true })
  const sourceBackupFilePath = path.join(sourceBackupDir, 'original.m4b')
  await makeTone(sourceBackupFilePath, 1, [
    '-metadata',
    'title=Should Never Be Ingested',
    '-metadata',
    'artist=Series Author',
    '-c:a',
    'aac',
  ])

  // --- A real book whose title happens to contain "Source" as a substring
  // — must NOT be caught by the backup-folder exclusion, which is
  // whole-name-only specifically to avoid this ---
  const legitimateSourceTitleDir = path.join(root, 'Series Author', 'Sourcery')
  await mkdir(legitimateSourceTitleDir, { recursive: true })
  const legitimateSourceTitleBookPath = path.join(legitimateSourceTitleDir, 'book.m4b')
  await makeTone(legitimateSourceTitleBookPath, 1, [
    '-metadata',
    'title=Sourcery',
    '-metadata',
    'artist=Series Author',
    '-c:a',
    'aac',
  ])

  // --- "To Delete" backup folder — a second naming convention found on the
  // real library (the Dresden Files books) alongside "zzzSource files":
  // leftover duplicate .m4b files sitting next to the real one, not yet
  // cleaned up on the NAS. Must be excluded the same way.
  const toDeleteBookDir = path.join(root, 'Some Author', 'To Delete Test Book')
  await mkdir(toDeleteBookDir, { recursive: true })
  const toDeleteBookPath = path.join(toDeleteBookDir, 'book.m4b')
  await makeTone(toDeleteBookPath, 1, [
    '-metadata',
    'title=To Delete Test Book',
    '-metadata',
    'artist=Some Author',
    '-c:a',
    'aac',
  ])
  const toDeleteBackupDir = path.join(toDeleteBookDir, 'To Delete')
  await mkdir(toDeleteBackupDir, { recursive: true })
  const toDeleteBackupFilePath = path.join(toDeleteBackupDir, 'old-copy.m4b')
  await makeTone(toDeleteBackupFilePath, 1, [
    '-metadata',
    'title=Should Never Be Ingested Either',
    '-metadata',
    'artist=Some Author',
    '-c:a',
    'aac',
  ])

  // --- Book with a corrupt cover.jpg sitting alongside a perfectly valid
  // m4b — reproduces the real "premature end of JPEG image" failure mode:
  // a bad cover image must not fail ingestion of the whole book, just skip
  // the artwork.
  const corruptCoverDir = path.join(root, 'Some Author', 'Corrupt Cover Book')
  await mkdir(corruptCoverDir, { recursive: true })
  const corruptCoverBookPath = path.join(corruptCoverDir, 'book.m4b')
  await makeTone(corruptCoverBookPath, 1, [
    '-metadata',
    'title=Corrupt Cover Book',
    '-metadata',
    'artist=Some Author',
    '-c:a',
    'aac',
  ])
  await writeFile(path.join(corruptCoverDir, 'cover.jpg'), Buffer.from('not a real jpeg, just garbage bytes'))

  // --- Corrupt M4B: real extension, no valid container data — reproduces
  // the "moov atom not found" failure mode seen from truncated transfers,
  // which must be skipped rather than aborting the whole scan ---
  const corruptDir = path.join(root, 'Broken Author', 'Truncated Book')
  await mkdir(corruptDir, { recursive: true })
  const corruptM4bPath = path.join(corruptDir, 'broken.m4b')
  await writeFile(corruptM4bPath, Buffer.from('not a real m4b container'))

  return {
    root,
    mp3FolderDir,
    m4bPath,
    drmPath,
    corruptM4bPath,
    splitBookDir,
    splitBookPart1,
    splitBookPart2,
    genericBookPart1,
    genericBookPart2,
    folderAuthorBookPath,
    garbledFolderBookPath,
    mixedFolderLooseBookPath,
    mixedFolderNestedBookPath,
    sourceBackupFilePath,
    legitimateSourceTitleBookPath,
    toDeleteBookPath,
    toDeleteBackupFilePath,
    corruptCoverBookPath,
  }
}
