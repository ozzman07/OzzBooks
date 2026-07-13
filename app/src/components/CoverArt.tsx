const PALETTE = [
  ['#7c3aed', '#4c1d95'],
  ['#0891b2', '#164e63'],
  ['#d97706', '#78350f'],
  ['#dc2626', '#7f1d1d'],
  ['#059669', '#064e3b'],
]

function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

interface CoverArtProps {
  title: string
  coverUrl?: string
  className?: string
}

export function CoverArt({ title, coverUrl, className = '' }: CoverArtProps) {
  if (coverUrl) {
    return (
      <img
        src={coverUrl}
        alt={`Cover art for ${title}`}
        className={`aspect-square w-full rounded-lg object-cover ${className}`}
      />
    )
  }

  const [from, to] = PALETTE[hashString(title) % PALETTE.length]

  return (
    <div
      role="img"
      aria-label={`Cover art placeholder for ${title}`}
      className={`flex aspect-square w-full items-center justify-center rounded-lg ${className}`}
      style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
    >
      <span className="text-3xl font-semibold text-white/90">
        {title.charAt(0).toUpperCase()}
      </span>
    </div>
  )
}
