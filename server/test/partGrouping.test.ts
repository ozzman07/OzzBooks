import { describe, expect, it } from 'vitest'
import {
  groupM4bParts,
  groupSiblingFolders,
  groupChapterRipsByPrefix,
  groupParenthesizedTrackRips,
  extractLeadingIndexTag,
} from '../src/ingestion/partGrouping.js'

describe('groupM4bParts', () => {
  it('groups files that share a title and differ only by a "Part N" keyword marker', () => {
    const { groups, singles } = groupM4bParts([
      'On a Pale Horse (Unabridged), Part 1.m4b',
      'On a Pale Horse (Unabridged), Part 2.m4b',
    ])
    expect(groups).toEqual([['On a Pale Horse (Unabridged), Part 1.m4b', 'On a Pale Horse (Unabridged), Part 2.m4b']])
    expect(singles).toEqual([])
  })

  it('tolerates a parenthesized part marker and a leading track-number prefix on only one file', () => {
    const { groups } = groupM4bParts([
      '01 Weilding a Red Sword (Unabridged), Part 1.m4b',
      'Weilding a Red Sword (Unabridged), Part 2.m4b',
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toHaveLength(2)
  })

  it('groups a bare trailing number with no keyword when 2+ files share a title and numbers are contiguous', () => {
    const { groups, singles } = groupM4bParts(['The Blade Itself  1.m4b', 'The Blade Itself  2.m4b', 'The Blade Itself  3.m4b'])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toEqual(['The Blade Itself  1.m4b', 'The Blade Itself  2.m4b', 'The Blade Itself  3.m4b'])
    expect(singles).toEqual([])
  })

  it('does NOT group a real multi-book series where titles differ beyond the number', () => {
    const files = [
      '[Destroyermen - 01] - Into the Storm.m4b',
      '[Destroyermen - 02] - Crusade.m4b',
      '[Destroyermen - 03] - Maelstrom.m4b',
    ]
    const { groups, singles } = groupM4bParts(files)
    expect(groups).toEqual([])
    expect(singles).toEqual(files)
  })

  it('does NOT group a single lone file that happens to end in a marker (needs 2+ to form a group)', () => {
    const files = ['Convergence, Book 1.m4b', 'Convergence: Convergence, Book 1 [B09ZZ8VMKL].m4b']
    const { groups, singles } = groupM4bParts(files)
    expect(groups).toEqual([])
    expect(singles).toEqual(files)
  })

  it('does NOT group bare-numbered files whose numbers are not a contiguous 1..N run', () => {
    // Same base title, but numbers 1 and 5 — not what a "Part 1, Part 2, ..."
    // split would ever produce, so treat as coincidence rather than parts.
    const files = ['Some Book 1.m4b', 'Some Book 5.m4b']
    const { groups, singles } = groupM4bParts(files)
    expect(groups).toEqual([])
    expect(singles).toEqual(files)
  })

  it('does NOT group bare-numbered files that normalize to a duplicate part number', () => {
    // Different filenames ("1" vs "01") that both parse to part number 1 —
    // two real files can't share a literal name, but they can collide after
    // normalization, which should still be treated as not a clean part run.
    const files = ['Some Book 1.m4b', 'Some Book 01.m4b', 'Some Book 2.m4b']
    const { groups } = groupM4bParts(files)
    expect(groups).toEqual([])
  })

  it('prefers the keyword grouping and leaves any remainder to the bare-number pass', () => {
    const files = ['My Book, Part 1.m4b', 'My Book, Part 2.m4b', 'Other Book 1.m4b', 'Other Book 2.m4b']
    const { groups, singles } = groupM4bParts(files)
    expect(groups).toHaveLength(2)
    expect(singles).toEqual([])
  })

  it('sorts grouped parts by part number regardless of input order', () => {
    const { groups } = groupM4bParts(['Book, Part 3.m4b', 'Book, Part 1.m4b', 'Book, Part 2.m4b'])
    expect(groups[0]).toEqual(['Book, Part 1.m4b', 'Book, Part 2.m4b', 'Book, Part 3.m4b'])
  })

  it('leaves an ordinary single-file book untouched', () => {
    const { groups, singles } = groupM4bParts(['Mistborn: The Final Empire.m4b'])
    expect(groups).toEqual([])
    expect(singles).toEqual(['Mistborn: The Final Empire.m4b'])
  })

  it('groups an unnumbered first part with a "-1" suffixed continuation (real-world rip convention)', () => {
    const { groups, singles } = groupM4bParts([
      'Raymond E. Feist - 10 Chaoswar 1 - A Kingdom Besieged.m4b',
      'Raymond E. Feist - 10 Chaoswar 1 - A Kingdom Besieged-1.m4b',
    ])
    expect(groups).toEqual([
      [
        'Raymond E. Feist - 10 Chaoswar 1 - A Kingdom Besieged.m4b',
        'Raymond E. Feist - 10 Chaoswar 1 - A Kingdom Besieged-1.m4b',
      ],
    ])
    expect(singles).toEqual([])
  })

  it('extends the implicit-part-0 grouping to a 3-part "-1"/"-2" continuation run', () => {
    const { groups } = groupM4bParts(['Title.m4b', 'Title-1.m4b', 'Title-2.m4b'])
    expect(groups).toEqual([['Title.m4b', 'Title-1.m4b', 'Title-2.m4b']])
  })

  it('does NOT admit an implicit part 0 when two unnumbered files would collide on the same base', () => {
    // "Title.m4b" and "TITLE.m4b" both normalize to the same base — genuinely
    // ambiguous which one (if either) is really part 0, so reject the whole
    // group rather than guessing.
    const files = ['Title.m4b', 'TITLE.m4b', 'Title-1.m4b']
    const { groups, singles } = groupM4bParts(files)
    expect(groups).toEqual([])
    expect(singles).toEqual(files)
  })
})

describe('groupSiblingFolders', () => {
  it('groups sibling directory names the same way as filenames (e.g. "Disc 1"/"Disc 2")', () => {
    const { groups, singles } = groupSiblingFolders(['Disc 1', 'Disc 2', 'Disc 3'])
    expect(groups).toEqual([['Disc 1', 'Disc 2', 'Disc 3']])
    expect(singles).toEqual([])
  })
})

// Every case here is a REAL filename pulled directly from the Google Drive
// source involved in the 2026-09-11 incident (see
// ozzbooks-google-drive-chapter-merge-fix memory) — not invented examples.
// The "must NOT merge" cases are exactly the folders that got wrongly
// merged by the earlier, unsafe "2+ files in a folder" heuristic; this
// suite exists specifically to prevent repeating that mistake.
describe('groupChapterRipsByPrefix', () => {
  it('merges a real 19-file chapter-per-file rip sharing one long title prefix', () => {
    const files = [
      'Going Postal: Discworld, Book 33 [B09M7FSBFC] - 01 - Opening Credits.m4b',
      'Going Postal: Discworld, Book 33 [B09M7FSBFC] - 02 - The 9,000 Year Prologue.m4b',
      'Going Postal: Discworld, Book 33 [B09M7FSBFC] - 03 - The One Month Prologue.m4b',
      'Going Postal: Discworld, Book 33 [B09M7FSBFC] - 04 - Chapter One: The Angel.m4b',
      'Going Postal: Discworld, Book 33 [B09M7FSBFC] - 05 - Chapter Two: The Post Office.m4b',
      'Going Postal: Discworld, Book 33 [B09M7FSBFC] - 06 - Chapter Three: Our Own Hand, Or None.m4b',
      'Going Postal: Discworld, Book 33 [B09M7FSBFC] - 07 - Chapter Four: A Sign.m4b',
      'Going Postal: Discworld, Book 33 [B09M7FSBFC] - 08 - Chapter Five: Lost in the Post.m4b',
      'Going Postal: Discworld, Book 33 [B09M7FSBFC] - 09 - Chapter Six: Little Pictures.m4b',
      'Going Postal: Discworld, Book 33 [B09M7FSBFC] - 10 - Chapter Seven: Tomb of Words.m4b',
      'Going Postal: Discworld, Book 33 [B09M7FSBFC] - 11 - Chapter Seven A: Post Haste.m4b',
      'Going Postal: Discworld, Book 33 [B09M7FSBFC] - 12 - Chapter Nine: Bonfire.m4b',
      'Going Postal: Discworld, Book 33 [B09M7FSBFC] - 13 - Chapter Ten: The Burning of Words.m4b',
      'Going Postal: Discworld, Book 33 [B09M7FSBFC] - 14 - Chapter Eleven: Mission Statement.m4b',
      'Going Postal: Discworld, Book 33 [B09M7FSBFC] - 15 - Chapter Twelve: The Woodpecker.m4b',
      'Going Postal: Discworld, Book 33 [B09M7FSBFC] - 16 - Chapter Thirteen: The Edge of the Envelope.m4b',
      'Going Postal: Discworld, Book 33 [B09M7FSBFC] - 17 - Chapter Fourteen: Deliverance.m4b',
      'Going Postal: Discworld, Book 33 [B09M7FSBFC] - 18 - Epilogue: Some Time After.m4b',
      'Going Postal: Discworld, Book 33 [B09M7FSBFC] - 19 - End Credits.m4b',
    ]
    const { groups, singles } = groupChapterRipsByPrefix(files)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toHaveLength(19)
    expect(groups[0][0]).toContain('01 - Opening Credits')
    expect(groups[0][18]).toContain('19 - End Credits')
    expect(singles).toEqual([])
  })

  it('does NOT merge a folder of separate standalone books sharing a short generic prefix and a number (the actual incident)', () => {
    const files = [
      'DCC - 1 - Dungeon Crawler Carl.m4b',
      "DCC - 2 - Carl's Doomsday Scenario Dungeon Crawler Carl.m4b",
      "DCC - 3 - The Dungeon Anarchist's Cookbook Dungeon Crawler Carl.m4b",
      'DCC - 4 - The Gate of the Feral Gods.m4b',
      "DCC - 5 - The Butcher's Masquerade.m4b",
      'DCC - 6 - The Eye of the Bedlam Bride.m4b',
      'DCC - 7 - This Inevitable Ruin.m4b',
      'DCC - 8 - A Parade of Horribles.m4b',
    ]
    const { groups, singles } = groupChapterRipsByPrefix(files)
    expect(groups).toEqual([])
    expect(singles).toEqual(files)
  })

  it('does NOT merge loose author-folder files that happen to each contain a number', () => {
    const files = [
      'Jim Butcher - Dresden 1 - Strom Front.m4b',
      'Jim Butcher - Dresden 15 - Skin Game.m4b',
      'Jim Butcher - Dresden 16 - Peace Talks.m4b',
      'Jim Butcher - Dresden 17 - Battle Ground.m4b',
      'Jim Butcher - Dresden 2 - Fool Moon.m4b',
    ]
    const { groups, singles } = groupChapterRipsByPrefix(files)
    expect(groups).toEqual([])
    expect(singles).toEqual(files)
  })

  it('does NOT merge separate books with entirely different titles (no shared prefix at all)', () => {
    const files = [
      'Catching Fire.m4b',
      'Mockingjay.m4b',
      'Sunrise on the Reaping.m4b',
      'The Ballad of Songbirds and Snakes A Hunger Games Novel.m4b',
      'The Hunger Games.m4b',
    ]
    const { groups, singles } = groupChapterRipsByPrefix(files)
    expect(groups).toEqual([])
    expect(singles).toEqual(files)
  })

  it('does NOT merge separate season releases where the varying part is a season/episode number, not a chapter label', () => {
    const files = [
      'DCC 01 Season 1 - Matt Dinniman (Audio Immersion Tunnel).m4b',
      'DCC 02 Season 2 - Matt Dinniman (Audio Immersion Tunnel).m4b',
      'DCC 03 Season 3 - Matt Dinniman (Audio Immersion Tunnel).m4b',
    ]
    const { groups, singles } = groupChapterRipsByPrefix(files)
    expect(groups).toEqual([])
    expect(singles).toEqual(files)
  })

  it('rejects a shared prefix that is too short even when the suffix looks chapter-like', () => {
    // "Bk" (2 chars) is well under the minimum-prefix-length safety net —
    // guards against a short/generic shared token producing a false match
    // purely because a suffix happens to contain a chapter-vocabulary word.
    const files = ['Bk - 1 - Chapter One.m4b', 'Bk - 2 - Chapter Two.m4b']
    const { groups, singles } = groupChapterRipsByPrefix(files)
    expect(groups).toEqual([])
    expect(singles).toEqual(files)
  })

  it('rejects a long, specific shared prefix when the numbering is not contiguous', () => {
    const files = [
      'Going Postal: Discworld, Book 33 [B09M7FSBFC] - 01 - Opening Credits.m4b',
      'Going Postal: Discworld, Book 33 [B09M7FSBFC] - 02 - The 9,000 Year Prologue.m4b',
      'Going Postal: Discworld, Book 33 [B09M7FSBFC] - 04 - Chapter One: The Angel.m4b', // gap at 03
    ]
    const { groups, singles } = groupChapterRipsByPrefix(files)
    expect(groups).toEqual([])
    expect(singles).toEqual(files)
  })

  it('does not match a number embedded in prose without a leading " - " delimiter (Book 33 stays part of the prefix)', () => {
    // Regression guard for the exact false-match risk this pattern must
    // avoid: "Book 33" is followed by a space, not " - ", so it must never
    // be mistaken for the chapter-number delimiter — only the real "- 01 -"
    // marker later in the string should match.
    const match = 'Going Postal: Discworld, Book 33 [B09M7FSBFC] - 01 - Opening Credits'.match(
      /^(.+)\s-\s(\d{1,3})\s-\s(.+)$/,
    )!
    expect(match[1]).toContain('Book 33')
    expect(match[2]).toBe('01')
  })

  it('merges a real 19-file chapter-per-file rip even though one file\'s label is "Author\'s Note" (Discworld #36 "Making Money")', () => {
    // Real case found sitting un-grouped in production: every file matched
    // the chapter-rip shape and had a recognized chapter label ("Chapter
    // N", "Opening Credits", "End Credits", "Epilogue") except file 02,
    // whose tag "Author's Note" wasn't in the recognized vocabulary —
    // which broke contiguity for the whole 1..19 run and left all 19 as
    // separate one-chapter books. Fixed by adding "author's note" to
    // CHAPTER_LABEL_WORD_RE.
    const files = [
      "Making Money: Discworld, Book 36 [B09MDL9C1T] - 01 - Opening Credits.m4b",
      "Making Money: Discworld, Book 36 [B09MDL9C1T] - 02 - Author's Note.m4b",
      'Making Money: Discworld, Book 36 [B09MDL9C1T] - 03 - Chapter 1.m4b',
      'Making Money: Discworld, Book 36 [B09MDL9C1T] - 04 - Chapter 2.m4b',
      'Making Money: Discworld, Book 36 [B09MDL9C1T] - 05 - Chapter 3.m4b',
      'Making Money: Discworld, Book 36 [B09MDL9C1T] - 06 - Chapter 4: Part 1.m4b',
      'Making Money: Discworld, Book 36 [B09MDL9C1T] - 07 - Chapter 4: Part 2.m4b',
      'Making Money: Discworld, Book 36 [B09MDL9C1T] - 08 - Chapter 5.m4b',
      'Making Money: Discworld, Book 36 [B09MDL9C1T] - 09 - Chapter 6: Part 1.m4b',
      'Making Money: Discworld, Book 36 [B09MDL9C1T] - 10 - Chapter 6: Part 2.m4b',
      'Making Money: Discworld, Book 36 [B09MDL9C1T] - 11 - Chapter 7.m4b',
      'Making Money: Discworld, Book 36 [B09MDL9C1T] - 12 - Chapter 8.m4b',
      'Making Money: Discworld, Book 36 [B09MDL9C1T] - 13 - Chapter 9.m4b',
      'Making Money: Discworld, Book 36 [B09MDL9C1T] - 14 - Chapter 10.m4b',
      'Making Money: Discworld, Book 36 [B09MDL9C1T] - 15 - Chapter 11.m4b',
      'Making Money: Discworld, Book 36 [B09MDL9C1T] - 16 - Chapter 12.m4b',
      'Making Money: Discworld, Book 36 [B09MDL9C1T] - 17 - Chapter 13.m4b',
      'Making Money: Discworld, Book 36 [B09MDL9C1T] - 18 - Epilogue.m4b',
      'Making Money: Discworld, Book 36 [B09MDL9C1T] - 19 - End Credits.m4b',
    ]
    const { groups, singles } = groupChapterRipsByPrefix(files)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toHaveLength(19)
    expect(singles).toEqual([])
  })

  it('merges a chapter-rip group via the identical-suffix fallback even when the repeated suffix has no recognized chapter vocabulary', () => {
    // General-purpose safety net: a per-book distinguishing title can never
    // be identical across every file in a folder, so an exactly-repeated
    // suffix is just as safe a signal as a real chapter-label word — this
    // covers whatever the next unrecognized-but-legitimate tag turns out
    // to be, instead of needing a fresh keyword patch each time one shows up.
    const files = [
      'Some Long Enough Book Title Here - 1 - Bonus Track.m4b',
      'Some Long Enough Book Title Here - 2 - Bonus Track.m4b',
      'Some Long Enough Book Title Here - 3 - Bonus Track.m4b',
    ]
    const { groups, singles } = groupChapterRipsByPrefix(files)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toHaveLength(3)
    expect(singles).toEqual([])
  })

  it('still rejects a shared-prefix group whose suffixes differ and don\'t look like chapter labels (the DCC/Dresden shape, unaffected by the identical-suffix fallback)', () => {
    const files = [
      'DCC - 1 - Dungeon Crawler Carl.m4b',
      "DCC - 2 - Carl's Doomsday Scenario Dungeon Crawler Carl.m4b",
    ]
    const { groups, singles } = groupChapterRipsByPrefix(files)
    expect(groups).toEqual([])
    expect(singles).toEqual(files)
  })
})

describe('groupParenthesizedTrackRips', () => {
  it('merges a real 9-file track rip sharing one long title prefix and an identical parenthesized tag (Discworld #27 "The Last Hero")', () => {
    // Real case found sitting un-grouped in production: this filename shape
    // ("<prefix> - <N> (<tag>)") has no second " - " delimiter before the
    // tag, so it never matched groupChapterRipsByPrefix's regex at all —
    // confirmed via web search that "The Last Hero" is a real single
    // Discworld novel (#27), consistent with 9 tracks of one audiobook.
    const files = [
      'DW27 - The Last Hero - 01 (enhanced).m4a',
      'DW27 - The Last Hero - 02 (enhanced).m4a',
      'DW27 - The Last Hero - 03 (enhanced).m4a',
      'DW27 - The Last Hero - 04 (enhanced).m4a',
      'DW27 - The Last Hero - 05 (enhanced).m4a',
      'DW27 - The Last Hero - 06 (enhanced).m4a',
      'DW27 - The Last Hero - 07 (enhanced).m4a',
      'DW27 - The Last Hero - 08 (enhanced).m4a',
      'DW27 - The Last Hero - 09 (enhanced).m4a',
    ]
    const { groups, singles } = groupParenthesizedTrackRips(files)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toHaveLength(9)
    expect(groups[0][0]).toContain('01 (enhanced)')
    expect(groups[0][8]).toContain('09 (enhanced)')
    expect(singles).toEqual([])
  })

  it('rejects a shared prefix that is too short even with an identical tag', () => {
    const files = ['DW - 1 (enhanced).m4a', 'DW - 2 (enhanced).m4a']
    const { groups, singles } = groupParenthesizedTrackRips(files)
    expect(groups).toEqual([])
    expect(singles).toEqual(files)
  })

  it('rejects a long, specific shared prefix when the tags differ (would be a per-book distinguishing subtitle, not a repeated technical tag)', () => {
    const files = [
      'Some Long Enough Book Title Here - 1 (First Distinct Subtitle).m4a',
      'Some Long Enough Book Title Here - 2 (Second Distinct Subtitle).m4a',
    ]
    const { groups, singles } = groupParenthesizedTrackRips(files)
    expect(groups).toEqual([])
    expect(singles).toEqual(files)
  })

  it('rejects a long, specific shared prefix when the numbering is not contiguous', () => {
    const files = [
      'DW27 - The Last Hero - 01 (enhanced).m4a',
      'DW27 - The Last Hero - 02 (enhanced).m4a',
      'DW27 - The Last Hero - 04 (enhanced).m4a', // gap at 03
    ]
    const { groups, singles } = groupParenthesizedTrackRips(files)
    expect(groups).toEqual([])
    expect(singles).toEqual(files)
  })

  it('does NOT match a season-release filename where the number precedes the dash instead of following it', () => {
    // Has a trailing parenthesized tag, but the number sits before "Season
    // N", not directly after the " - " delimiter the way this pattern
    // requires — so it never matches this shape at all, regardless of the
    // tag being repeated.
    const files = [
      'DCC 01 Season 1 - Matt Dinniman (Audio Immersion Tunnel).m4b',
      'DCC 02 Season 2 - Matt Dinniman (Audio Immersion Tunnel).m4b',
    ]
    const { groups, singles } = groupParenthesizedTrackRips(files)
    expect(groups).toEqual([])
    expect(singles).toEqual(files)
  })
})

describe('extractLeadingIndexTag', () => {
  it('strips a real "(#N) Title" Discworld folder-name prefix into a series index', () => {
    // Real folder names found sitting un-extracted in production — every
    // one of these became a book whose displayed title was the raw folder
    // name, "(#N)" and all, with series_number left NULL forever.
    expect(extractLeadingIndexTag('(#16) Soul Music')).toEqual({ title: 'Soul Music', index: 16 })
    expect(extractLeadingIndexTag('(#9) Eric')).toEqual({ title: 'Eric', index: 9 })
    expect(extractLeadingIndexTag('(#36) Making Money')).toEqual({ title: 'Making Money', index: 36 })
    expect(extractLeadingIndexTag('(#40) Raising Steam')).toEqual({ title: 'Raising Steam', index: 40 })
  })

  it('leaves an ordinary title with no such prefix untouched', () => {
    expect(extractLeadingIndexTag('Going Postal')).toEqual({ title: 'Going Postal', index: null })
    expect(extractLeadingIndexTag('Dungeon Crawler Carl')).toEqual({ title: 'Dungeon Crawler Carl', index: null })
  })

  it('does not misfire on a title that merely contains a parenthesized number elsewhere', () => {
    expect(extractLeadingIndexTag('The Last Hero (Book #27)')).toEqual({
      title: 'The Last Hero (Book #27)',
      index: null,
    })
  })

  it('does not misfire on a plain leading number with no "(#" marker (a real book could be numbered that way)', () => {
    expect(extractLeadingIndexTag('1984')).toEqual({ title: '1984', index: null })
    expect(extractLeadingIndexTag('16 Soul Music')).toEqual({ title: '16 Soul Music', index: null })
  })
})
