import type { AuthService } from './auth.ts'
import type { AuthorizationRepository, PendingDeviceRecord } from './authorization.ts'
import type { Config } from './config.ts'

export type PairingResolution =
  | { state: 'pending'; id: string; record: PendingDeviceRecord }
  | { state: 'approved'; id: string; record: PendingDeviceRecord }
  | { state: 'missing' }

export interface PairingRequest {
  bearer: string
  id: string
  record: PendingDeviceRecord
}

export interface PairingService {
  request(authority: string, browser: string | undefined, existingBearer?: string): Promise<PairingRequest>
  resolve(bearer: string, authority: string): Promise<PairingResolution>
}

export function createPairingService(
  config: Config,
  auth: AuthService,
  repository: AuthorizationRepository,
  now: () => number = Date.now,
): PairingService {
  const ttlMs = config.pendingTtlMinutes * 60 * 1000

  return {
    async request(authority, browser, existingBearer) {
      const currentTime = now()
      if (existingBearer !== undefined && existingBearer.length > 0) {
        const existingId = auth.digestBearer(existingBearer)
        const existing = repository.getPending(existingId)
        if (existing !== undefined && existing.expiresAt > currentTime && existing.authority === authority) {
          return { bearer: existingBearer, id: existingId, record: existing }
        }
      }

      const bearer = auth.newPairingBearer()
      const id = auth.digestBearer(bearer)
      const record: PendingDeviceRecord = {
        authority,
        browser,
        requestedAt: currentTime,
        expiresAt: currentTime + ttlMs,
        state: 'pending',
      }
      await repository.putPending(id, record)
      return { bearer, id, record }
    },

    async resolve(bearer, authority) {
      const id = auth.digestBearer(bearer)
      const item = repository.getPending(id)
      if (item === undefined || item.authority !== authority) return { state: 'missing' }
      if (item.expiresAt <= now()) {
        await repository.consumePending(id)
        return { state: 'missing' }
      }
      return { state: item.state, id, record: item }
    },
  }
}
