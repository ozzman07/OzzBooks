import { createApp } from './api/app.js'
import { config } from './config.js'
import { getDb } from './db/index.js'
import { registerProvider, registerScanner } from './integrations/remote/registry.js'
import { googleDriveProvider } from './integrations/remote/googleDrive/provider.js'
import { scanGoogleDriveSource } from './integrations/remote/googleDrive/remoteScan.js'

getDb() // ensure schema is migrated before accepting requests

// Registered here (not in api/app.ts) deliberately — tests construct the
// app via createApp() directly and shouldn't pick this up implicitly;
// tests that need a registered provider/scanner register one explicitly.
registerProvider(googleDriveProvider)
registerScanner('google_drive', scanGoogleDriveSource)

const app = createApp()
app.listen(config.port, () => {
  console.log(`OzzBooks file-serving API listening on :${config.port}`)
})
