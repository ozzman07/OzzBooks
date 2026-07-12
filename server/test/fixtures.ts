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

  return { root, mp3FolderDir, m4bPath, drmPath }
}
