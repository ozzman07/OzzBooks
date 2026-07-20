import { beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'

process.env.DATABASE_URL = 'postgres://ozzbooks:ozzbooks_dev@localhost:5432/ozzbooks_cloud_test'
process.env.OZZBOOKS_JWT_SECRET = 'test-secret'

let app: import('express').Express
let token: string
let userId: string
const email = `test-${Date.now()}@example.com`

beforeAll(async () => {
  const { migrate, getPool } = await import('../src/db/index.js')
  await migrate()
  // Real Postgres test DB, not mocked — clean slate per run.
  await getPool().query(
    'TRUNCATE users, progress, bookmarks, downloads, user_settings, playlists, playlist_items, annotations, reading_prefs, book_position_map CASCADE',
  )

  const { createApp } = await import('../src/api/app.js')
  app = createApp()
}, 30_000)

describe('auth', () => {
  it('rejects signup with a short password', async () => {
    const res = await request(app).post('/auth/signup').send({ email, password: 'short' })
    expect(res.status).toBe(400)
  })

  it('signs up a new user and returns a usable token', async () => {
    const res = await request(app).post('/auth/signup').send({ email, password: 'correct-horse-battery' })
    expect(res.status).toBe(201)
    expect(res.body.token).toBeTruthy()
    expect(res.body.user.email).toBe(email)
    token = res.body.token
    userId = res.body.user.id
  })

  it('rejects a duplicate signup', async () => {
    const res = await request(app).post('/auth/signup').send({ email, password: 'correct-horse-battery' })
    expect(res.status).toBe(409)
  })

  it('rejects login with the wrong password', async () => {
    const res = await request(app).post('/auth/login').send({ email, password: 'wrong-password' })
    expect(res.status).toBe(401)
  })

  it('logs in with the right password', async () => {
    const res = await request(app).post('/auth/login').send({ email, password: 'correct-horse-battery' })
    expect(res.status).toBe(200)
    expect(res.body.token).toBeTruthy()
  })

  it('resolves the current user from the token', async () => {
    const res = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(userId)
  })

  it('rejects protected routes with no token', async () => {
    const res = await request(app).get('/sync/progress')
    expect(res.status).toBe(401)
  })

  it('rejects a garbage token', async () => {
    const res = await request(app).get('/sync/progress').set('Authorization', 'Bearer not-a-real-token')
    expect(res.status).toBe(401)
  })
})

describe('self-service password/email change (no reset-flow infra exists, so this is the alternative)', () => {
  it('rejects a password change with the wrong current password', async () => {
    const res = await request(app)
      .patch('/auth/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'wrong-password', newPassword: 'brand-new-password' })
    expect(res.status).toBe(401)
  })

  it('rejects a new password shorter than 8 characters', async () => {
    const res = await request(app)
      .patch('/auth/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'correct-horse-battery', newPassword: 'short' })
    expect(res.status).toBe(400)
  })

  it('changes the password and the old one stops working', async () => {
    const res = await request(app)
      .patch('/auth/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'correct-horse-battery', newPassword: 'brand-new-password' })
    expect(res.status).toBe(204)

    const oldLogin = await request(app).post('/auth/login').send({ email, password: 'correct-horse-battery' })
    expect(oldLogin.status).toBe(401)

    const newLogin = await request(app).post('/auth/login').send({ email, password: 'brand-new-password' })
    expect(newLogin.status).toBe(200)

    // The original token must still work — it only encodes userId, not
    // anything password-derived, so changing the password shouldn't force
    // a re-login on whatever session made the change.
    const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`)
    expect(me.status).toBe(200)
  })

  it('rejects an email change with the wrong current password', async () => {
    const res = await request(app)
      .patch('/auth/email')
      .set('Authorization', `Bearer ${token}`)
      .send({ newEmail: 'wrong-password-attempt@example.com', currentPassword: 'not-the-right-one' })
    expect(res.status).toBe(401)
  })

  it('rejects an email change to one already in use', async () => {
    const otherEmail = `other-email-${Date.now()}@example.com`
    await request(app).post('/auth/signup').send({ email: otherEmail, password: 'correct-horse-battery' })

    const res = await request(app)
      .patch('/auth/email')
      .set('Authorization', `Bearer ${token}`)
      .send({ newEmail: otherEmail, currentPassword: 'brand-new-password' })
    expect(res.status).toBe(409)
  })

  it('changes the email and can log in with the new one', async () => {
    const newEmail = `changed-${Date.now()}@example.com`
    const res = await request(app)
      .patch('/auth/email')
      .set('Authorization', `Bearer ${token}`)
      .send({ newEmail, currentPassword: 'brand-new-password' })
    expect(res.status).toBe(200)
    expect(res.body.email).toBe(newEmail)

    const newLogin = await request(app).post('/auth/login').send({ email: newEmail, password: 'brand-new-password' })
    expect(newLogin.status).toBe(200)

    const oldLogin = await request(app).post('/auth/login').send({ email, password: 'brand-new-password' })
    expect(oldLogin.status).toBe(401)
  })
})

describe('progress sync (last-write-wins)', () => {
  const bookId = 'book-123'

  it('creates progress on first write', async () => {
    const res = await request(app)
      .put(`/sync/progress/${bookId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ position: { type: 'timestamp', value: 120 }, chapterId: 'ch1', updatedAt: '2026-01-01T00:00:00Z' })
    expect(res.status).toBe(200)
    expect(res.body.position.value).toBe(120)
  })

  it('applies a newer write', async () => {
    const res = await request(app)
      .put(`/sync/progress/${bookId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ position: { type: 'timestamp', value: 300 }, chapterId: 'ch2', updatedAt: '2026-01-02T00:00:00Z' })
    expect(res.status).toBe(200)
    expect(res.body.position.value).toBe(300)
  })

  it('rejects a stale write from a device that synced late, keeping the newer value', async () => {
    const res = await request(app)
      .put(`/sync/progress/${bookId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ position: { type: 'timestamp', value: 50 }, chapterId: 'ch1', updatedAt: '2026-01-01T12:00:00Z' })
    expect(res.status).toBe(409)
    expect(res.body.position.value).toBe(300) // the newer write still wins

    const current = await request(app).get(`/sync/progress/${bookId}`).set('Authorization', `Bearer ${token}`)
    expect(current.body.position.value).toBe(300)
  })

  it('lists all progress for the Continue Listening shelf', async () => {
    const res = await request(app).get('/sync/progress').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.some((p: any) => p.book_id === bookId)).toBe(true)
  })

  it("can't read another user's progress via a mismatched book id lookup returning 404, and is scoped per-user", async () => {
    const otherSignup = await request(app)
      .post('/auth/signup')
      .send({ email: `other-${Date.now()}@example.com`, password: 'correct-horse-battery' })
    const otherToken = otherSignup.body.token

    const res = await request(app).get(`/sync/progress/${bookId}`).set('Authorization', `Bearer ${otherToken}`)
    expect(res.status).toBe(404) // this other user has no progress on this book
  })
})

describe('bookmarks', () => {
  const bookId = 'book-123'
  let bookmarkId: string

  it('creates a bookmark, separate from continuous progress', async () => {
    const res = await request(app)
      .post('/sync/bookmarks')
      .set('Authorization', `Bearer ${token}`)
      .send({ bookId, position: { type: 'timestamp', value: 42 }, label: 'Great line here' })
    expect(res.status).toBe(201)
    bookmarkId = res.body.id
  })

  it('lists bookmarks for a book', async () => {
    const res = await request(app).get(`/sync/bookmarks?bookId=${bookId}`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].label).toBe('Great line here')
  })

  it('deletes a bookmark', async () => {
    const res = await request(app).delete(`/sync/bookmarks/${bookmarkId}`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(204)

    const list = await request(app).get(`/sync/bookmarks?bookId=${bookId}`).set('Authorization', `Bearer ${token}`)
    expect(list.body).toHaveLength(0)
  })
})

describe('settings', () => {
  it('has defaults from signup', async () => {
    const res = await request(app).get('/sync/settings').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.playback_speed).toBe(1)
  })

  it('updates settings', async () => {
    const res = await request(app)
      .put('/sync/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ playbackSpeed: 1.5, skipSilenceEnabled: true })
    expect(res.status).toBe(200)
    expect(res.body.playback_speed).toBe(1.5)
    expect(res.body.skip_silence_enabled).toBe(true)
  })
})

describe('downloads', () => {
  it('upserts a download record', async () => {
    const res = await request(app)
      .put('/sync/downloads/book-123/ch1')
      .set('Authorization', `Bearer ${token}`)
      .send({ sizeBytes: 1024 })
    expect(res.status).toBe(200)
    expect(res.body.size_bytes).toBe('1024') // bigint comes back as string from pg
  })

  it('lists downloads', async () => {
    const res = await request(app).get('/sync/downloads').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
  })
})

describe('playlists', () => {
  let namedPlaylistId: string
  let upNextId: string
  let firstItemId: string
  let secondItemId: string

  it('auto-creates exactly one reserved Up Next playlist at signup', async () => {
    const res = await request(app).get('/sync/playlists').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    const reserved = res.body.filter((p: any) => p.is_reserved)
    expect(reserved).toHaveLength(1)
    expect(reserved[0].name).toBe('Up Next')
    upNextId = reserved[0].id
  })

  it('creates a named playlist, listed after Up Next', async () => {
    const res = await request(app)
      .post('/sync/playlists')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bedtime Stories' })
    expect(res.status).toBe(201)
    expect(res.body.is_reserved).toBe(false)
    namedPlaylistId = res.body.id

    const list = await request(app).get('/sync/playlists').set('Authorization', `Bearer ${token}`)
    expect(list.body[0].is_reserved).toBe(true) // Up Next always first
    expect(list.body.some((p: any) => p.id === namedPlaylistId)).toBe(true)
  })

  it('renames the named playlist but rejects renaming Up Next', async () => {
    const res = await request(app)
      .patch(`/sync/playlists/${namedPlaylistId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Car Trips' })
    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Car Trips')

    const blocked = await request(app)
      .patch(`/sync/playlists/${upNextId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Not Up Next' })
    expect(blocked.status).toBe(400)
  })

  it('quick-adds a book to Up Next', async () => {
    const res = await request(app)
      .post(`/sync/playlists/${upNextId}/items`)
      .set('Authorization', `Bearer ${token}`)
      .send({ bookId: 'book-aaa' })
    expect(res.status).toBe(201)
    expect(res.body.position).toBe(0)
    firstItemId = res.body.id

    const get = await request(app).get(`/sync/playlists/${upNextId}`).set('Authorization', `Bearer ${token}`)
    expect(get.body.items).toHaveLength(1)
    expect(get.body.items[0].book_id).toBe('book-aaa')
  })

  it('adds a second item and reorders them', async () => {
    const addRes = await request(app)
      .post(`/sync/playlists/${upNextId}/items`)
      .set('Authorization', `Bearer ${token}`)
      .send({ bookId: 'book-bbb' })
    expect(addRes.status).toBe(201)
    secondItemId = addRes.body.id
    expect(addRes.body.position).toBe(1)

    const reorder = await request(app)
      .put(`/sync/playlists/${upNextId}/items`)
      .set('Authorization', `Bearer ${token}`)
      .send({ itemIds: [secondItemId, firstItemId] })
    expect(reorder.status).toBe(200)
    expect(reorder.body.map((i: any) => i.id)).toEqual([secondItemId, firstItemId])
    expect(reorder.body[0].position).toBe(0)
    expect(reorder.body[1].position).toBe(1)
  })

  it('rejects a reorder whose item-id set no longer matches the playlist', async () => {
    const res = await request(app)
      .put(`/sync/playlists/${upNextId}/items`)
      .set('Authorization', `Bearer ${token}`)
      .send({ itemIds: [firstItemId] }) // missing secondItemId
    expect(res.status).toBe(409)
  })

  it('removes an item', async () => {
    const res = await request(app)
      .delete(`/sync/playlists/${upNextId}/items/${secondItemId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(204)

    const get = await request(app).get(`/sync/playlists/${upNextId}`).set('Authorization', `Bearer ${token}`)
    expect(get.body.items).toHaveLength(1)
    expect(get.body.items[0].id).toBe(firstItemId)
  })

  it('deletes the named playlist but rejects deleting Up Next', async () => {
    const res = await request(app)
      .delete(`/sync/playlists/${namedPlaylistId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(204)

    const blocked = await request(app).delete(`/sync/playlists/${upNextId}`).set('Authorization', `Bearer ${token}`)
    expect(blocked.status).toBe(400)
  })

  it("can't access another user's playlists", async () => {
    const otherSignup = await request(app)
      .post('/auth/signup')
      .send({ email: `other-playlists-${Date.now()}@example.com`, password: 'correct-horse-battery' })
    const otherToken = otherSignup.body.token

    const get = await request(app).get(`/sync/playlists/${upNextId}`).set('Authorization', `Bearer ${otherToken}`)
    expect(get.status).toBe(404)

    const rename = await request(app)
      .patch(`/sync/playlists/${upNextId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ name: 'Hijacked' })
    expect(rename.status).toBe(404)

    const del = await request(app).delete(`/sync/playlists/${upNextId}`).set('Authorization', `Bearer ${otherToken}`)
    expect(del.status).toBe(404)

    const addItem = await request(app)
      .post(`/sync/playlists/${upNextId}/items`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ bookId: 'book-ccc' })
    expect(addItem.status).toBe(404)

    const reorder = await request(app)
      .put(`/sync/playlists/${upNextId}/items`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ itemIds: [] })
    expect(reorder.status).toBe(404)
  })

  it('rejects protected routes with no token', async () => {
    const res = await request(app).get('/sync/playlists')
    expect(res.status).toBe(401)
  })
})
