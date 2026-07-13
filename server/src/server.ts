import { createApp } from './api/app.js'
import { config } from './config.js'
import { getDb } from './db/index.js'

getDb() // ensure schema is migrated before accepting requests

const app = createApp()
app.listen(config.port, () => {
  console.log(`OzzBooks file-serving API listening on :${config.port}`)
})
