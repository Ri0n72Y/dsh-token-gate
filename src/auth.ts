import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Config } from './config.ts'

interface RateBucket {
  windowStart: number
  count: number
}

export interface AuthService {
  authorizeBootstrap(clientKey: string, submitted: string): boolean
  newPairingBearer(): string
  sessionBearerForPairing(pairingBearer: string): string
  digestBearer(value: string): string
  readSessionCookie(req: IncomingMessage): string | undefined
  readPairingCookie(req: IncomingMessage): string | undefined
  sessionCookie(value: string, secure: boolean, maxAgeSeconds: number): string
  pairingCookie(value: string, secure: boolean, maxAgeSeconds: number): string
  clearPairingCookie(secure: boolean): string
  stripGatewayCookies(raw: string): string | undefined
  isGatewaySetCookie(raw: string): boolean
}

function tokenDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function readCookie(req: IncomingMessage, cookieName: string): string | undefined {
  const raw = req.headers.cookie
  if (typeof raw !== 'string') return undefined
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === cookieName) return part.slice(eq + 1).trim()
  }
  return undefined
}

function assertCookieName(name: string): void {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
    throw new Error(`token-gate: invalid cookie name: ${JSON.stringify(name)}`)
  }
}

function cookie(name: string, value: string, secure: boolean, maxAgeSeconds: number): string {
  const base = `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`
  return secure ? `${base}; Secure` : base
}

export function createAuthService(config: Config, token: string): AuthService {
  assertCookieName(config.cookieName)
  assertCookieName(config.pairingCookieName)
  const rateWindowMs = config.rateWindowMinutes * 60 * 1000
  const expectedDigest = tokenDigest(token)
  const attempts = new Map<string, RateBucket>()
  let lastRateSweep = Date.now()

  function sweepRateBuckets(now: number): void {
    if (now - lastRateSweep < rateWindowMs) return
    for (const [key, bucket] of attempts) {
      if (now - bucket.windowStart >= rateWindowMs) attempts.delete(key)
    }
    lastRateSweep = now
  }

  function allowAttempt(key: string): boolean {
    const now = Date.now()
    sweepRateBuckets(now)
    const existing = attempts.get(key)
    if (existing !== undefined) {
      if (now - existing.windowStart >= rateWindowMs) {
        attempts.set(key, { windowStart: now, count: 1 })
        return true
      }
      if (existing.count >= config.rateMax) return false
      existing.count += 1
      return true
    }
    if (attempts.size >= config.rateMaxKeys) return false
    attempts.set(key, { windowStart: now, count: 1 })
    return true
  }

  const gatewayCookies = new Set([config.cookieName, config.pairingCookieName])

  return {
    authorizeBootstrap(clientKey, submitted) {
      if (!allowAttempt(clientKey)) return false
      return timingSafeEqual(tokenDigest(submitted), expectedDigest)
    },

    newPairingBearer() {
      return randomBytes(32).toString('base64url')
    },

    sessionBearerForPairing(pairingBearer) {
      return createHmac('sha256', token).update(`session:${pairingBearer}`, 'utf8').digest('base64url')
    },

    digestBearer(value) {
      return createHash('sha256').update(value, 'utf8').digest('hex')
    },

    readSessionCookie(req) {
      return readCookie(req, config.cookieName)
    },

    readPairingCookie(req) {
      return readCookie(req, config.pairingCookieName)
    },

    sessionCookie(value, secure, maxAgeSeconds) {
      return cookie(config.cookieName, value, secure, maxAgeSeconds)
    },

    pairingCookie(value, secure, maxAgeSeconds) {
      return cookie(config.pairingCookieName, value, secure, maxAgeSeconds)
    },

    clearPairingCookie(secure) {
      return cookie(config.pairingCookieName, '', secure, 0)
    },

    stripGatewayCookies(raw) {
      const kept = raw.split(';').map(part => part.trim()).filter((part) => {
        const eq = part.indexOf('=')
        if (eq === -1) return part.length > 0
        return !gatewayCookies.has(part.slice(0, eq).trim())
      })
      return kept.length > 0 ? kept.join('; ') : undefined
    },

    isGatewaySetCookie(raw) {
      const eq = raw.indexOf('=')
      return eq !== -1 && gatewayCookies.has(raw.slice(0, eq).trim())
    },
  }
}
