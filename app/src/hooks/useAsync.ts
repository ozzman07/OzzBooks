import { useCallback, useEffect, useState } from 'react'

type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'success'; data: T }

/** Runs `fetcher` on mount (and whenever `deps` change), exposing a retry
 * for the "can't reach your library, retry" case from Claude.md's
 * stream-failure fallback design. */
export function useAsync<T>(fetcher: () => Promise<T>, deps: unknown[]): AsyncState<T> & { retry: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  const retry = useCallback(() => setAttempt((a) => a + 1), [])

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    fetcher()
      .then((data) => {
        if (!cancelled) setState({ status: 'success', data })
      })
      .catch((error) => {
        if (!cancelled) setState({ status: 'error', error })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, attempt])

  return { ...state, retry }
}
