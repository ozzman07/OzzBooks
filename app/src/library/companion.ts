import type { Book } from '../types'

// A companion pair (an audiobook and ebook of the same title, linked via
// companion_book_id — see server/'s companionLink.ts) should behave as one
// book for shelf purposes: adding/removing either side adds/removes both.
export function companionLibraryIds(book: Pick<Book, 'id' | 'companionBookId'>): string[] {
  return [book.id, book.companionBookId].filter((id): id is string => !!id)
}

export function bookInLibrary(book: Pick<Book, 'id' | 'companionBookId'>, ids: Set<string>): boolean {
  return companionLibraryIds(book).some((id) => ids.has(id))
}
