// Minimal in-memory stand-in for the Cache Storage API (`caches`), which
// Node has no built-in implementation of (unlike `fetch`/`Response`, which
// Node provides natively) — this project's audio offline-storage code
// (audioFileStore.ts, offlineAudioRange.ts) uses it directly, mirroring
// how `fake-indexeddb/auto` stands in for IndexedDB in this same test
// environment. Only implements the handful of methods actually used:
// `caches.open(name)` then `.match()`/`.put()`/`.delete()` by string key —
// real callers here never pass a Request object, only a URL string.
class FakeCache {
  private store = new Map<string, Response>()

  async match(key: string): Promise<Response | undefined> {
    const res = this.store.get(key)
    return res ? res.clone() : undefined
  }

  async put(key: string, response: Response): Promise<void> {
    this.store.set(key, response.clone())
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key)
  }
}

class FakeCacheStorage {
  private caches = new Map<string, FakeCache>()

  async open(name: string): Promise<FakeCache> {
    if (!this.caches.has(name)) this.caches.set(name, new FakeCache())
    return this.caches.get(name)!
  }
}

export function installFakeCacheStorage(): void {
  ;(globalThis as unknown as { caches: FakeCacheStorage }).caches = new FakeCacheStorage()
}
