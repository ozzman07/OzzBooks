import { describe, expect, it } from 'vitest'
import { shouldRunNow } from '../src/ingestion/nightlyRescan.js'
import type { AppSettingsRow } from '../src/types.js'

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
