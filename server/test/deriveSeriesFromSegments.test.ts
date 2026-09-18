import { describe, expect, it } from 'vitest'
import { deriveSeriesFromSegments } from '../src/ingestion/scan.js'

describe('deriveSeriesFromSegments', () => {
  it('resolves the real series folder sitting behind a generic "Series" category layer (real case: Turtledove)', () => {
    // Real case found in production: "Turtledove, Harry/Series/Crosstime
    // Traffic/Crosstime Traffic 05 - The Gladiator.epub" put the literal
    // word "Series" into series_name for 49 books instead of the real
    // series name one level deeper. 49 books genuinely share this folder,
    // so this exercises the sibling-count requirement below too.
    expect(deriveSeriesFromSegments(['Turtledove, Harry', 'Series', 'Crosstime Traffic'], 49)).toBe('Crosstime Traffic')
  })

  it('does not fall through to a standalone book\'s own wrapper folder as a "series of one" when the folder above it is invalid (real case: "_History Books/_World History/A History of the World in 12 Maps")', () => {
    // Real case: a lone nonfiction book sitting by itself in its own
    // uniquely-named wrapper folder, one level under an underscore topic
    // bucket, read as its own series — series_name landed on the exact
    // same string as the book's own title ("A History of the World in 12
    // Maps", "Agincourt: Henry V..."). The one-level-deeper fallback exists
    // for a folder genuinely shared by many books (see the Turtledove case
    // above with siblingBookCount 49); with only 1 sibling it must return
    // null instead of trusting the book's own folder name as a series.
    expect(
      deriveSeriesFromSegments(['_History Books', '_World History', 'A History of the World in 12 Maps']),
    ).toBeNull()
  })

  it('returns null for a generic category bucket with no real series behind it (real case: "Novels", "Short Stories")', () => {
    // Real case: many unrelated standalone Patterson novels sit flat in a
    // "Novels" folder, and many unrelated Arthur C. Clarke short works sit
    // flat in a "Short Stories" folder — both used to read as if the
    // category label itself were the series, for every book sharing it.
    expect(deriveSeriesFromSegments(['Patterson, James', 'Novels'], 40)).toBeNull()
    expect(deriveSeriesFromSegments(['Clark, Arthur C', 'Short Stories'], 8)).toBeNull()
    expect(deriveSeriesFromSegments(['Clark, Arthur C', 'short stories'], 8)).toBeNull() // case-insensitive
    expect(deriveSeriesFromSegments(['Clark, Arthur C', 'Shortfiction'], 8)).toBeNull()
  })

  it('returns null for a "Collections" bucket shared by unrelated authors (real case: Philip Roth and Harry Turtledove)', () => {
    // Real case: "Roth, Philip/Collections/Shop Talk.epub" and
    // "Turtledove, Harry/Collections/Atlantis and Other Places.epub" both
    // put the literal word "Collections" into series_name, wrongly
    // grouping two completely unrelated authors' unrelated short-story/
    // essay collections as if they were one series.
    expect(deriveSeriesFromSegments(['Roth, Philip', 'Collections'], 2)).toBeNull()
    expect(deriveSeriesFromSegments(['Turtledove, Harry', 'Collections'], 4)).toBeNull()
  })

  it('returns null for an underscore grab-bag topic folder acting as the series level (real case: "_American History")', () => {
    // Real case: "_History Books/_American History/book.epub" — a topic
    // bucket, not a real series, put "_American History" into
    // series_name for 48 unrelated books. Same underscore convention
    // deriveAuthorFromSegments already applies to the author level.
    expect(deriveSeriesFromSegments(['_History Books', '_American History'], 48)).toBeNull()
  })

  it('strips a leading 1-2 digit chronology index from a real series/era name (real case: Star Wars eras)', () => {
    // Real case: "Star Wars/2 Rise of the Empire Era 33-1 BBY/.../book.m4b"
    // correctly identifies the era folder as the series level, but left
    // the leading "2 " (this era's position in the saga's own timeline,
    // not this book's position within the era) stuck on the front.
    expect(deriveSeriesFromSegments(['Star Wars', '2 Rise of the Empire Era 33-1 BBY', 'Some Book Folder'])).toBe(
      'Rise of the Empire Era 33-1 BBY',
    )
    expect(deriveSeriesFromSegments(['Star Wars', '4 New Republic Era 6.5 - 22 ABY', 'Some Book Folder'])).toBe(
      'New Republic Era 6.5 - 22 ABY',
    )
  })

  it('strips a "N - Title" leading index cleanly, without leaving a dangling dash (real case: Star Wars "33 - Correllian Trilogy...")', () => {
    // Real bug caught before this shipped: the first version of this fix
    // only stripped the digits plus one adjacent separator, so "33 -
    // Correllian Trilogy 2 - Assault at Selonia" (digit, space, dash,
    // space) came out as "- Correllian Trilogy 2 - Assault at Selonia" —
    // the leading dash left behind.
    expect(
      deriveSeriesFromSegments(['Star Wars', '33 - Correllian Trilogy 2 - Assault at Selonia', 'Some Book Folder']),
    ).toBe('Correllian Trilogy 2 - Assault at Selonia')
  })

  it('collapses a double space baked into the real folder name (real case: "The  Hand of Thrawn Duology")', () => {
    expect(deriveSeriesFromSegments(['Zahn, Timothy', '06 - The  Hand of Thrawn Duology'], 2)).toBe(
      'The Hand of Thrawn Duology',
    )
  })

  it('does not strip a 4-digit year from the front of a real series/title', () => {
    // Guards against over-broadening: a real series/title that happens to
    // start with a 4-digit year must survive untouched — only a short
    // 1-2 digit index prefix is an index, not a year.
    expect(deriveSeriesFromSegments(['Some Author', '1984 Trilogy', 'Some Book Folder'])).toBe('1984 Trilogy')
  })

  it('still returns the plain series folder in the ordinary case with no generic layer or index prefix', () => {
    expect(deriveSeriesFromSegments(['Butcher, Jim', 'The Dresden Files', 'Storm Front'])).toBe('The Dresden Files')
  })

  it('still requires 2+ siblings to treat a flat two-segment folder as a series, same as before', () => {
    expect(deriveSeriesFromSegments(['Some Author', 'Some Standalone Book Folder'], 1)).toBeNull()
    expect(deriveSeriesFromSegments(['Some Author', 'Some Series Folder'], 2)).toBe('Some Series Folder')
  })

  it('returns null for a book sitting directly under the author folder with no series layer at all', () => {
    expect(deriveSeriesFromSegments(['Some Author'])).toBeNull()
  })

  it('returns null when a garbled per-disc remnant folder sits beneath the book\'s own folder, instead of mistaking the book\'s own folder for a series (real case: Anne Rice CD rips)', () => {
    // Real case: old CD rips left a garbled 8.3-style per-disc folder
    // directly under the book's own year-prefixed folder, e.g. "Rice,
    // Anne/1990 - The Witching Hour (MW1 - read by Laura
    // Giannarelli)/1O912L~0/track.mp3". Before this fix, the book's own
    // folder passed as a plausible series name (not underscore-prefixed,
    // not itself garbled, not a generic label, and its leading 4-digit
    // year is deliberately never stripped) and got returned as the
    // series — reported by the user as "a series using 1986 instead of
    // Belinda" and "1990 instead of the witching hour", clarifying "the
    // witching hour is a book, not a series".
    expect(
      deriveSeriesFromSegments(['Rice, Anne', '1990 - The Witching Hour (MW1 - read by Laura Giannarelli)', '1O912L~0']),
    ).toBeNull()
    expect(deriveSeriesFromSegments(['Rice, Anne', '1986 - Belinda (read by Ray Bouche)', '2WJ9VZ~K'])).toBeNull()
    expect(deriveSeriesFromSegments(['Rice, Anne', '1982 - Cry to Heaven (read by Ray Hagen)', '3P8QI7~K'])).toBeNull()
    expect(
      deriveSeriesFromSegments(['Rice, Anne', '1985 - The Vampire Lestat (VC2 - read by Frank Muller)', '4O0WXS~P']),
    ).toBeNull()
  })

  it('returns null for a bare "Lastname, First" author folder holding several standalone books, instead of treating the author as a series (real case: "_History/Chernow, Ron")', () => {
    // Real case: "_History/Chernow, Ron/Grant.m4b", ".../Titan - The Life
    // of John D Rockefeller Sr..m4b", etc. — 4 unrelated standalone
    // nonfiction books sharing a bare author-name folder read as one
    // "series" literally named "Chernow, Ron" instead of not being a
    // series at all. Same "Lastname, First" shape looksLikeAuthorFolderName
    // already treats as an author folder one level up.
    expect(deriveSeriesFromSegments(['_History', 'Chernow, Ron'], 4)).toBeNull()
    expect(deriveSeriesFromSegments(['_History', 'Leckie, Robert'], 16)).toBeNull()
  })

  it('strips a "Lastname, First - " author-name prefix off a real series name instead of rejecting the whole folder (real case: "Cornwell, Bernard - The Saxon Stories")', () => {
    // Real case: "_History/Cornwell, Bernard - The Saxon Stories/..."
    // fragmented "The Saxon Stories" into two separate series entries —
    // one clean, one still carrying this author-name prefix — instead of
    // being recognized as the same series either way.
    expect(deriveSeriesFromSegments(['_History', 'Cornwell, Bernard - The Saxon Stories'], 10)).toBe(
      'The Saxon Stories',
    )
  })

  it('does not mistake a numeric era-range folder for an author-name prefix (real case: Star Wars "1 Old Republic Era 4,000 BBY - 3,996 BBY")', () => {
    // Regression caught before this shipped: the author-name-prefix strip
    // above matched this purely on the comma-then-dash shape, treating
    // "...Era 4" / "000 BBY" as a fake "Lastname, First" and stripping the
    // whole era name down to the bare fragment "3,996 BBY". The
    // author-prefix strip must require both name parts to be digit-free.
    expect(
      deriveSeriesFromSegments(['Star Wars', '1 Old Republic Era 4,000 BBY - 3,996 BBY', 'Some Book Folder']),
    ).toBe('Old Republic Era 4,000 BBY - 3,996 BBY')
  })

  it('does not drill one level deeper when primary was rejected for a reason other than a generic category label, even with 2+ folder-sharing candidates (real cases: an underscore bucket, and a bare author-name folder)', () => {
    // Regression caught before this shipped: "_History Books/_American
    // Civil War/Goodheart, Adam/1861_ The Civil War Awakening - Adam
    // Goodheart/book.epub" had 2 format-variant files sitting in the
    // book's own wrapper folder (siblingBookCount 2, from file variants of
    // the very same single book, not 2 distinct titles), which was enough
    // to let the one-level-deeper fallback wrongly land on the book's own
    // folder name as a "series" once "Goodheart, Adam" was rejected as a
    // bare author-name folder. The fallback must only ever trigger when
    // primary was rejected specifically as a generic category label (see
    // the Turtledove case above) — any other rejection reason must return
    // null outright, regardless of sibling count.
    expect(
      deriveSeriesFromSegments(
        ['_History Books', '_American Civil War', 'Goodheart, Adam', '1861_ The Civil War Awakening - Adam Goodheart'],
        2,
      ),
    ).toBeNull()
    expect(deriveSeriesFromSegments(['_History Books', '_American History', 'Some Book Folder'], 2)).toBeNull()
  })
})
