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

interface FfprobeJson {
  format?: { duration?: string }
  chapters?: Array<{
    start_time: string
    end_time: string
    tags?: { title?: string }
  }>
}

function parseFfprobeOutput(stdout: string): FfprobeResult {
  const parsed = JSON.parse(stdout) as FfprobeJson
  const duration = Number(parsed.format?.duration ?? 0)
  const chapters = (parsed.chapters ?? []).map((c, index) => ({
    title: c.tags?.title || `Chapter ${index + 1}`,
    startTime: Number(c.start_time),
    endTime: Number(c.end_time),
  }))
  return { duration, chapters }
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
  return parseFfprobeOutput(stdout)
}

/**
 * Same extraction, pointed at a remote URL instead of a local path — used
 * for remote sources, where the file is never downloaded whole. ffmpeg's
 * own HTTPS handler does its own Range-based seeking internally to find
 * chapter/moov data wherever it lives in the file, so there's no manual
 * chunk-size guessing here. This is *why* remote M4B chapters go through
 * ffprobe rather than a pure buffer/tokenizer approach — confirmed by
 * grepping node_modules that the installed music-metadata version doesn't
 * parse Nero-style "chpl" chapter atoms, only QuickTime chapter tracks.
 * Headers are passed via ffprobe's own -headers flag (array-args
 * execFile, not shell-interpolated — safe from injection).
 */
export async function readContainerInfoFromUrl(
  url: string,
  headers: Record<string, string>,
): Promise<FfprobeResult> {
  const headerLines = Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n')
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-headers',
    `${headerLines}\r\n`,
    '-print_format',
    'json',
    '-show_format',
    '-show_chapters',
    url,
  ])
  return parseFfprobeOutput(stdout)
}
