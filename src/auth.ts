import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Config } from './config.ts'

interface Session {
  createdAt: number
  expiresAt: number
  authority: string
}

interface RateBucket {
  windowStart: number
  count: number
}

export interface AuthService {
  hasRequestSession(req: IncomingMessage, authority: string): boolean
  authorizeBootstrap(clientKey: string, submitted: string): boolean
  createSession(authority: string): string | undefined
  sessionCookie(id: string, secure: boolean): string
  stripSessionCookie(raw: string): string | undefined
  isSessionSetCookie(raw: string): boolean
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

export function createAuthService(config: Config, token: string): AuthService {
  assertCookieName(config.cookieName)
  const ttlMs = config.sessionTtlDays * 24 * 60 * 60 * 1000
  const rateWindowMs = config.rateWindowMinutes * 60 * 1000
  const expectedDigest = tokenDigest(token)
  const sessions = new Map<string, Session>()
  const attempts = new Map<string, RateBucket>()
  let lastRateSweep = Date.now()

  function pruneSessions(): void {
    const now = Date.now()
    for (const [id, session] of sessions) {
      if (now > session.expiresAt) sessions.delete(id)
    }
  }

  function getSession(id: string | undefined): Session | undefined {
    if (id === undefined || id.length === 0) return undefined
    const session = sessions.get(id)
    if (session === undefined) return undefined
    if (Date.now() > session.expiresAt) {
      sessions.delete(id)
      return undefined
    }
    return session
  }

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

  return {
    hasRequestSession(req, authority) {
      const session = getSession(readCookie(req, config.cookieName))
      return session !== undefined && session.authority === authority
    },

    authorizeBootstrap(clientKey, submitted) {
      if (!allowAttempt(clientKey)) return false
      return timingSafeEqual(tokenDigest(submitted), expectedDigest)
    },

    createSession(authority) {
      pruneSessions()
      if (sessions.size >= config.sessionMax) return undefined
      const now = Date.now()
      const id = randomUUID()
      sessions.set(id, { createdAt: now, expiresAt: now + ttlMs, authority })
      return id
    },

    sessionCookie(id, secure) {
      const base = `${config.cookieName}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(ttlMs / 1000)}`
      return secure ? `${base}; Secure` : base
    },

    stripSessionCookie(raw) {
      const kept = raw.split(';').map(part => part.trim()).filter((part) => {
        const eq = part.indexOf('=')
        if (eq === -1) return part.length > 0
        return part.slice(0, eq).trim() !== config.cookieName
      })
      return kept.length > 0 ? kept.join('; ') : undefined
    },

    isSessionSetCookie(raw) {
      const eq = raw.indexOf('=')
      return eq !== -1 && raw.slice(0, eq).trim() === config.cookieName
    },
  }
}
