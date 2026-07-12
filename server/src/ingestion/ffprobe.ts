import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface FfprobeChapter {
  title: string
  startTime: number
  endTime: number
}

export interface FfprobeResult {
  duration: number
  chapters: FfprobeChapter[]
}

/**
 * Reads container-level duration and embedded chapter markers via ffprobe.
 * Handles both Nero-style ("chpl") and QuickTime chapter-track M4B chapters —
 * ffprobe's demuxer normalizes both to the same `chapters` array, which is
 * why we shell out to it rather than hand-parsing MP4 boxes ourselves.
 */
export async function readContainerInfo(filePath: string): Promise<FfprobeResult> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_chapters',
    filePath,
  ])

  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string }
    chapters?: Array<{
      start_time: string
      end_time: string
      tags?: { title?: string }
    }>
  }

  const duration = Number(parsed.format?.duration ?? 0)
  const chapters = (parsed.chapters ?? []).map((c, index) => ({
    title: c.tags?.title || `Chapter ${index + 1}`,
    startTime: Number(c.start_time),
    endTime: Number(c.end_time),
  }))

  return { duration, chapters }
}
