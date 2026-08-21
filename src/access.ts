import type { IncomingMessage } from 'node:http'
import type { Config } from './config.ts'
import type { AuthService } from './auth.ts'
import { firstHeader, IpSet, normalizeIp } from './net.ts'

export type AccessDecision = 'allow' | 'bootstrap' | 'deny'

export interface AccessPolicy {
  decide(req: IncomingMessage): AccessDecision
  bootstrapToken(req: IncomingMessage): string | undefined
  cleanBootstrapLocation(req: IncomingMessage): string
  clientIp(req: IncomingMessage): string
  isSecure(req: IncomingMessage): boolean
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://token-gate.invalid')
}

export function createAccessPolicy(config: Config, auth: AuthService): AccessPolicy {
  const allowedIps = new IpSet(config.allowIps)
  const trustedProxies = new IpSet(config.trustedProxies)

  function clientIp(req: IncomingMessage): string {
    const peer = normalizeIp(req.socket.remoteAddress)
    if (!trustedProxies.has(peer)) return peer

    const cf = firstHeader(req.headers, 'cf-connecting-ip')
    if (cf !== undefined && normalizeIp(cf).length > 0) return normalizeIp(cf)

    const xff = firstHeader(req.headers, 'x-forwarded-for')
    if (xff !== undefined) {
      const first = normalizeIp(xff.split(',')[0])
      if (first.length > 0) return first
    }
    return peer
  }

  function bootstrapToken(req: IncomingMessage): string | undefined {
    const token = requestUrl(req).searchParams.get('token')
    return token === null || token.length === 0 ? undefined : token
  }

  return {
    decide(req) {
      if (bootstrapToken(req) !== undefined) return 'bootstrap'
      if (auth.hasRequestSession(req)) return 'allow'
      if (allowedIps.has(clientIp(req))) return 'allow'
      return 'deny'
    },

    bootstrapToken,

    cleanBootstrapLocation(req) {
      const url = requestUrl(req)
      url.searchParams.delete('token')
      const query = url.searchParams.toString()
      return `${url.pathname}${query.length > 0 ? `?${query}` : ''}`
    },

    clientIp,

    isSecure(req) {
      const peer = normalizeIp(req.socket.remoteAddress)
      if (!trustedProxies.has(peer)) return false
      const proto = firstHeader(req.headers, 'x-forwarded-proto')
      if (proto !== undefined && proto.split(',')[0].trim().toLowerCase() === 'https') return true
      const cf = firstHeader(req.headers, 'cf-visitor')
      if (cf !== undefined) {
        try {
          const value: unknown = JSON.parse(cf)
          return value !== null && typeof value === 'object' && (value as { scheme?: unknown }).scheme === 'https'
        } catch {
          return false
        }
      }
      return false
    },
  }
}
