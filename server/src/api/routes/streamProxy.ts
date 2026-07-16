import type { Response } from 'express'
import type { SourceRow } from '../../types.js'
import { getProvider } from '../../integrations/remote/registry.js'

/**
 * Groundwork only — no concrete remote provider exists yet, so this
 * always 503s with a clear message rather than doing anything. Once a
 * provider is registered and remote streaming is implemented, this
 * becomes the Range-forwarding proxy to the provider's authenticated
 * download endpoint (see the plan file for the full design: forward the
 * client's Range header, pipe the response stream straight through
 * without buffering, mirror status/Content-Range/Accept-Ranges back,
 * distinguish a confirmed auth failure from a genuine 404).
 */
export function proxyRemoteStream(source: SourceRow, res: Response): void {
  const provider = getProvider(source.type)
  const message = provider
    ? `Remote streaming for source type "${source.type}" is not implemented yet`
    : `No provider registered for source type "${source.type}" yet`
  res.status(503).json({ error: 'source unavailable', detail: message })
}
