// Mirrors server/src/ingestion/enrichment/genreOptions.ts's GENRE_OPTIONS.
// No shared package exists between app/ and server/ (see cleanTitleForSearch
// in enrichBooks.ts for the same duplication call elsewhere in this repo) —
// kept as a plain duplicated list rather than introducing shared-package
// infrastructure for one array. Used for the Book Detail genre dropdown and
// the Library/Store genre filter facet; the mapping logic that produces
// these values from raw subject tags stays server-only.
export const GENRE_OPTIONS = [
  'Fantasy',
  'Science Fiction',
  'Mystery & Thriller',
  'Horror',
  'Romance',
  'Historical Fiction',
  'Literary Fiction',
  'Young Adult',
  'Humor',
  'Biography & Memoir',
  'History',
  'Science & Nature',
  'Self-Help & Personal Development',
  'Business',
  'True Crime',
  'Religion & Spirituality',
  'Classics',
] as const

export type GenreOption = (typeof GENRE_OPTIONS)[number]
