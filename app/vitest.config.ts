import { defineConfig } from 'vitest/config'

// Scoped to offline/ — the one piece of frontend logic the addendum calls
// out for real automated coverage (existing, currently-untested-by-name
// logic the shipped audio download feature depends on, being reshaped to
// also cover comics and epub). Everything else in this app stays manual
// click-through per Claude.md's testing philosophy; this isn't a general
// "now test the whole frontend" shift.
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    include: ['src/offline/**/*.test.ts'],
  },
})
