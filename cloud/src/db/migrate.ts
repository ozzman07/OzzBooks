import { migrate, closePool } from './index.js'

migrate()
  .then(() => {
    console.log('Migration complete.')
    return closePool()
  })
  .catch((err) => {
    console.error('Migration failed:', err)
    process.exitCode = 1
  })
