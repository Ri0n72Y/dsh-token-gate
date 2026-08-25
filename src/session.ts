import type { AuthService } from './auth.ts'
import type { AuthorizationRepository, PendingDeviceRecord } from './authorization.ts'
import type { Config } from './config.ts'

export type SessionDecision =
  | { allowed: false }
  | { allowed: true; deviceId: string; refreshCookie?: string; renewalError?: unknown }

export interface IssuedDeviceSession {
  deviceId: string
  bearer: string
  cookie: string
}

export interface DeviceSessionService {
  issueApprovedSession(
    pairingBearer: string,
    pairingId: string,
    pending: PendingDeviceRecord,
    secure: boolean,
  ): Promise<IssuedDeviceSession>
  validate(sessionBearer: string | undefined, authority: string, secure: boolean): Promise<SessionDecision>
}

export function createDeviceSessionService(
  config: Config,
  auth: AuthService,
  repository: AuthorizationRepository,
  now: () => number = Date.now,
): DeviceSessionService {
  const ttlMs = config.sessionTtlDays * 24 * 60 * 60 * 1000
  const renewalMs = config.renewalIntervalHours * 60 * 60 * 1000
  const ttlSeconds = Math.floor(ttlMs / 1000)

  return {
    async issueApprovedSession(pairingBearer, pairingId, pending, secure) {
      if (pending.state !== 'approved') throw new Error('token-gate: pending device is not approved')
      const bearer = auth.sessionBearerForPairing(pairingBearer)
      const deviceId = auth.digestBearer(bearer)
      if (pending.issuedDeviceId !== undefined && pending.issuedDeviceId !== deviceId) {
        throw new Error('token-gate: pending device was already exchanged for another session')
      }

      const currentTime = now()
      const issued = await repository.issueDevice(pairingId, deviceId, {
        authority: pending.authority,
        browser: pending.browser,
        createdAt: currentTime,
        lastSeenAt: currentTime,
        expiresAt: currentTime + ttlMs,
        renewAfter: currentTime + renewalMs,
        pairingId,
      })
      if (issued === undefined) {
        throw new Error('token-gate: approved pending device disappeared or was revoked during session issue')
      }

      return {
        deviceId,
        bearer,
        cookie: auth.sessionCookie(bearer, secure, ttlSeconds),
      }
    },

    async validate(sessionBearer, authority, secure) {
      if (sessionBearer === undefined || sessionBearer.length === 0) return { allowed: false }
      const deviceId = auth.digestBearer(sessionBearer)
      const item = repository.getDevice(deviceId)
      const currentTime = now()
      if (item === undefined || item.authority !== authority || item.expiresAt <= currentTime) return { allowed: false }
      if (currentTime < item.renewAfter) return { allowed: true, deviceId }

      const renewed = {
        ...item,
        lastSeenAt: currentTime,
        expiresAt: currentTime + ttlMs,
        renewAfter: currentTime + renewalMs,
      }
      try {
        const stillAuthorized = await repository.renewDevice(deviceId, renewed)
        if (!stillAuthorized) return { allowed: false }
        return {
          allowed: true,
          deviceId,
          refreshCookie: auth.sessionCookie(sessionBearer, secure, ttlSeconds),
        }
      } catch (renewalError) {
        return { allowed: true, deviceId, renewalError }
      }
    },
  }
}
