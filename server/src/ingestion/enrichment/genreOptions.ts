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

// Keyword -> bucket. Raw subject tags (from Open Library search results and
// from epub OPF <dc:subject> metadata) are free text with no fixed
// vocabulary — real examples pulled from this library's own data include
// "Fiction, science fiction, general", "franchise:Red Rising",
// "Xanth (Imaginary place)", "award:hugo_award=1963" (see Claude.md Phase
// 2b note, 2026-08-16). Matching is keyword-based and deliberately not
// exhaustive: a subject that doesn't hit any pattern below is left
// unmapped rather than forced into a wrong bucket — the Book Detail/filter
// "Unset" state is the intended fallback for those, not a bug to chase.
const GENRE_KEYWORDS: [GenreOption, RegExp][] = [
  ['Science Fiction', /science fiction|\bsci-?fi\b/i],
  ['Fantasy', /\bfantasy\b|\bmagic\b|\bwizard/i],
  ['Mystery & Thriller', /\bmystery\b|\bdetective\b|\bthriller\b|private investigat|\bmurder\b|\bcrime\b/i],
  ['Horror', /\bhorror\b|\bsupernatural\b|\bghost stor/i],
  ['Romance', /\bromance\b|\block story\b/i],
  ['Historical Fiction', /historical fiction/i],
  ['Young Adult', /young adult|\bteen(age)?\b/i],
  ['Humor', /\bhumor\b|\bhumour\b|\bcomic\b|\bsatire\b/i],
  ['Biography & Memoir', /\bbiograph|\bmemoir/i],
  ['True Crime', /true crime/i],
  ['History', /\bhistory\b|\bwar,? \d{4}/i],
  ['Science & Nature', /\bscience\b(?!.{0,15}fiction)|\bnature\b|\bphysics\b|\bbiology\b/i],
  ['Self-Help & Personal Development', /self-help|self help|personal development|self-improvement/i],
  ['Business', /\bbusiness\b|\beconomics\b|\bmanagement\b|\bentrepreneur/i],
  ['Religion & Spirituality', /\breligio|\bspiritual|\btheology\b/i],
  ['Classics', /\bclassic literature\b|\bclassics\b/i],
  ['Literary Fiction', /american literature|english literature|literary fiction|\bliterature\b/i],
]

/**
 * Scores every raw subject string against each controlled genre's keyword
 * pattern and returns whichever bucket collected the most hits across all
 * subjects — more robust than "first subject that matches something",
 * since a book's subject list is unordered noise, not ranked by relevance.
 * Returns null (stays unmapped) rather than guessing when nothing matches.
 */
export function mapToControlledGenre(subjects: string[] | null | undefined): GenreOption | null {
  if (!subjects || subjects.length === 0) return null
  const scores = new Map<GenreOption, number>()
  for (const subject of subjects) {
    // Open Library namespaced tags like "franchise:Red Rising",
    // "award:hugo_award=1963", "series:Expeditionary Force" carry no
    // genre signal at all — skip outright rather than risk their free
    // text accidentally matching a keyword.
    if (/^[a-z]+:/i.test(subject)) continue
    for (const [genre, pattern] of GENRE_KEYWORDS) {
      if (pattern.test(subject)) {
        scores.set(genre, (scores.get(genre) ?? 0) + 1)
      }
    }
  }
  let best: GenreOption | null = null
  let bestScore = 0
  for (const [genre, score] of scores) {
    if (score > bestScore) {
      best = genre
      bestScore = score
    }
  }
  return best
}
