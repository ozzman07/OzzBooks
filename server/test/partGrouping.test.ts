import { describe, expect, it } from 'vitest'
import { groupM4bParts, groupSiblingFolders } from '../src/ingestion/partGrouping.js'

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
})

describe('groupSiblingFolders', () => {
  it('groups sibling directory names the same way as filenames (e.g. "Disc 1"/"Disc 2")', () => {
    const { groups, singles } = groupSiblingFolders(['Disc 1', 'Disc 2', 'Disc 3'])
    expect(groups).toEqual([['Disc 1', 'Disc 2', 'Disc 3']])
    expect(singles).toEqual([])
  })
})
