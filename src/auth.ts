import { timingSafeEqual, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Config } from './config.ts'

interface Session {
  createdAt: number
  expiresAt: number
}

export interface AuthService {
  hasRequestSession(req: IncomingMessage): boolean
  authorizeBootstrap(clientKey: string, submitted: string): boolean
  createSession(): string
  sessionCookie(id: string, secure: boolean): string
  stripSessionCookie(raw: string): string | undefined
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
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

export function createAuthService(config: Config, token: string): AuthService {
  const ttlMs = config.sessionTtlDays * 24 * 60 * 60 * 1000
  const rateWindowMs = config.rateWindowMinutes * 60 * 1000
  const sessions = new Map<string, Session>()
  const attempts = new Map<string, number[]>()

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

  function allowAttempt(key: string): boolean {
    const now = Date.now()
    const list = (attempts.get(key) ?? []).filter(timestamp => now - timestamp < rateWindowMs)
    if (list.length >= config.rateMax) {
      attempts.set(key, list)
      return false
    }
    list.push(now)
    attempts.set(key, list)
    if (attempts.size > 2000) {
      for (const [candidate, timestamps] of attempts) {
        const kept = timestamps.filter(timestamp => now - timestamp < rateWindowMs)
        if (kept.length === 0) attempts.delete(candidate)
        else attempts.set(candidate, kept)
      }
    }
    return true
  }

  return {
    hasRequestSession(req) {
      pruneSessions()
      return getSession(readCookie(req, config.cookieName)) !== undefined
    },

    authorizeBootstrap(clientKey, submitted) {
      return allowAttempt(clientKey) && safeEqual(submitted, token)
    },

    createSession() {
      pruneSessions()
      const now = Date.now()
      const id = randomUUID()
      sessions.set(id, { createdAt: now, expiresAt: now + ttlMs })
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
  }
}
