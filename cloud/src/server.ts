import { createApp } from './api/app.js'
import { config } from './config.js'
import { migrate } from './db/index.js'

await migrate()

const app = createApp()
app.listen(config.port, () => {
  console.log(`OzzBooks cloud sync/auth service listening on :${config.port}`)
})
