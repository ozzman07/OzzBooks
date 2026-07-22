import { NavLink } from 'react-router-dom'

const items = [
  { to: '/', label: 'Library', icon: '📚' },
  { to: '/playlists', label: 'Playlists', icon: '🎵' },
  { to: '/now-playing', label: 'Now Playing', icon: '▶️' },
  { to: '/settings', label: 'Settings', icon: '⚙️' },
]

export function BottomNav() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-app/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
      <ul className="mx-auto flex max-w-md">
        {items.map((item) => (
          <li key={item.to} className="flex-1">
            <NavLink
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex flex-col items-center gap-1 py-2 text-xs ${
                  isActive ? 'text-amber-400' : 'text-muted'
                }`
              }
            >
              <span className="text-xl" aria-hidden="true">
                {item.icon}
              </span>
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
