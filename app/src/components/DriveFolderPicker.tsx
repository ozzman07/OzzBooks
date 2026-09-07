import { useState } from 'react'
import { fetchDrivePickerToken, setSourceFolder, type ApiSource } from '../api/client'

const PICKER_API_KEY = import.meta.env.VITE_GOOGLE_PICKER_API_KEY ?? ''

// Minimal ambient shape for the bits of Google's Picker API this component
// actually uses — there's no first-party TS package for a CDN-loaded
// global, and pulling in a community @types package for four properties
// isn't worth it.
interface PickerDoc {
  id: string
  // Present for anything that's ever been shared via a link — Drive's
  // API 404s on the id alone in that case, even for the owner, so this
  // has to be forwarded to the backend rather than dropped.
  resourceKey?: string
}
interface PickerResponse {
  action: string
  docs?: PickerDoc[]
}
interface PickerDocsView {
  setIncludeFolders(v: boolean): PickerDocsView
  setSelectFolderEnabled(v: boolean): PickerDocsView
  setMimeTypes(v: string): PickerDocsView
}
interface PickerBuilder {
  addView(view: PickerDocsView): PickerBuilder
  setOAuthToken(token: string): PickerBuilder
  setDeveloperKey(key: string): PickerBuilder
  setCallback(cb: (data: PickerResponse) => void): PickerBuilder
  build(): { setVisible(v: boolean): void }
}
interface GooglePicker {
  ViewId: { FOLDERS: string }
  Action: { PICKED: string }
  DocsView: new (viewId: string) => PickerDocsView
  PickerBuilder: new () => PickerBuilder
}
declare global {
  interface Window {
    gapi?: { load: (api: string, callback: () => void) => void }
    google?: { picker: GooglePicker }
  }
}

let pickerApiLoadPromise: Promise<void> | null = null

// Loaded lazily, only when a picker is actually opened — no reason to pull
// in Google's script for every visitor, including the vast majority who'll
// never touch this.
function loadPickerApi(): Promise<void> {
  if (window.google?.picker) return Promise.resolve()
  if (pickerApiLoadPromise) return pickerApiLoadPromise

  pickerApiLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://apis.google.com/js/api.js'
    script.onload = () => {
      window.gapi!.load('picker', () => resolve())
    }
    script.onerror = () => {
      pickerApiLoadPromise = null
      reject(new Error('Failed to load the Google Picker script'))
    }
    document.head.appendChild(script)
  })
  return pickerApiLoadPromise
}

export function DriveFolderPicker({ source, onPicked }: { source: ApiSource; onPicked: (updated: ApiSource) => void }) {
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function open() {
    if (!PICKER_API_KEY) {
      setError("Google Picker isn't configured on this server yet (missing API key).")
      return
    }
    setError(null)
    setOpening(true)
    try {
      const [{ accessToken }] = await Promise.all([fetchDrivePickerToken(source.id), loadPickerApi()])
      const picker = window.google!.picker

      const view = new picker.DocsView(picker.ViewId.FOLDERS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(true)
        .setMimeTypes('application/vnd.google-apps.folder')

      new picker
        .PickerBuilder()
        .addView(view)
        .setOAuthToken(accessToken)
        .setDeveloperKey(PICKER_API_KEY)
        .setCallback((data: PickerResponse) => {
          if (data.action !== picker.Action.PICKED) return
          const doc = data.docs?.[0]
          if (!doc?.id) return
          void setSourceFolder(source.id, doc.id, doc.resourceKey)
            .then(onPicked)
            .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        })
        .build()
        .setVisible(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setOpening(false)
    }
  }

  return (
    <div>
      <button
        onClick={() => void open()}
        disabled={opening}
        className="text-xs text-amber-400 underline disabled:opacity-50"
      >
        {opening ? 'Opening…' : 'Choose an existing folder instead'}
      </button>
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  )
}
