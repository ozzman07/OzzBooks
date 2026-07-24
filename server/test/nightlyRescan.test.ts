import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { shouldRunNow } from '../src/ingestion/nightlyRescan.js'
import type { AppSettingsRow } from '../src/types.js'

vi.mock('../src/ingestion/enrichment/enrichBooks.js', () => ({
  enrichBooks: vi.fn(),
}))

beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-nightly-'))
  process.env.OZZBOOKS_DATA_DIR = dataDir
}, 30_000)

function settings(overrides: Partial<AppSettingsRow> = {}): AppSettingsRow {
  return {
    id: 1,
    nightly_rescan_enabled: 1,
    nightly_rescan_time: '02:00',
    nightly_rescan_last_run_date: null,
    updated_at: '2026-01-01 00:00:00',
    ...overrides,
  }
}

describe('shouldRunNow', () => {
  it('fires once the scheduled time has passed and it has not already run today', () => {
    const now = new Date(2026, 0, 15, 2, 30) // 2026-01-15 02:30 local
    expect(shouldRunNow(settings({ nightly_rescan_time: '02:00' }), now)).toBe(true)
  })

  it('does not fire when disabled', () => {
    const now = new Date(2026, 0, 15, 2, 30)
    expect(shouldRunNow(settings({ nightly_rescan_enabled: 0, nightly_rescan_time: '02:00' }), now)).toBe(false)
  })

  it('does not fire again if it already ran today', () => {
    const now = new Date(2026, 0, 15, 2, 30)
    expect(
      shouldRunNow(
        settings({ nightly_rescan_time: '02:00', nightly_rescan_last_run_date: '2026-01-15' }),
        now,
      ),
    ).toBe(false)
  })

  it('does not fire before the scheduled time', () => {
    const now = new Date(2026, 0, 15, 1, 30)
    expect(shouldRunNow(settings({ nightly_rescan_time: '02:00' }), now)).toBe(false)
  })

  it('catches up same-day if the scheduled time was missed (e.g. server was asleep)', () => {
    const now = new Date(2026, 0, 15, 9, 0) // well past the 02:00 target
    expect(
      shouldRunNow(
        settings({ nightly_rescan_time: '02:00', nightly_rescan_last_run_date: '2026-01-14' }),
        now,
      ),
    ).toBe(true)
  })
})

// No sources are inserted for either test below — the scan loop is then a
// no-op, isolating exactly the new wiring this covers: does enrichBooks()
// get called once scanning is done, and does the nightly run still get
// marked complete even if it throws unexpectedly (enrichBooks() itself
// already handles an actual Open Library outage gracefully without
// throwing — see enrichBooks.test.ts — so this is purely the backstop for
// something else going wrong).
describe('runNightlyRescan', () => {
  it('runs metadata enrichment once scanning every source has finished', async () => {
    const { enrichBooks } = await import('../src/ingestion/enrichment/enrichBooks.js')
    vi.mocked(enrichBooks).mockResolvedValue({
      attempted: 0,
      genreUpdated: 0,
      coverUpdated: 0,
      skipped: 0,
      failed: 0,
      abortedDueToUnavailability: false,
    })

    const { runNightlyRescan } = await import('../src/ingestion/nightlyRescan.js')
    await runNightlyRescan()

    expect(enrichBooks).toHaveBeenCalledTimes(1)
  })

  it('still marks the nightly run complete even if metadata enrichment throws unexpectedly', async () => {
    const { enrichBooks } = await import('../src/ingestion/enrichment/enrichBooks.js')
    vi.mocked(enrichBooks).mockRejectedValueOnce(new Error('unexpected bug'))

    const { getDb } = await import('../src/db/index.js')
    const db = getDb()
    db.prepare('UPDATE app_settings SET nightly_rescan_last_run_date = NULL WHERE id = 1').run()

    const { runNightlyRescan } = await import('../src/ingestion/nightlyRescan.js')
    await runNightlyRescan()

    const row = db.prepare('SELECT * FROM app_settings WHERE id = 1').get() as AppSettingsRow
    expect(row.nightly_rescan_last_run_date).toBeTruthy()
  })
})
