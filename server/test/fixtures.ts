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
  }
}
