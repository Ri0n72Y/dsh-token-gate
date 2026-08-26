import { isIP } from 'node:net'
import type { IncomingMessage } from 'node:http'
import type { Config } from './config.ts'
import { firstHeader, IpSet, normalizeIp } from './net.ts'

export const HOST_ADMIN_PREFIX = '/__token-gate'
export const PAIRING_PREFIX = '/_token-gate'

export interface AccessPolicy {
  bootstrapToken(req: IncomingMessage): string | undefined
  cleanBootstrapLocation(req: IncomingMessage): string
  isSecure(req: IncomingMessage): boolean
  requestAuthority(req: IncomingMessage): string | undefined
  isBrowserTrusted(req: IncomingMessage): boolean
  isHostAdminPath(req: IncomingMessage): boolean
  isPairingPath(req: IncomingMessage): boolean
}

function requestUrl(req: IncomingMessage): URL | undefined {
  try {
    return new URL(req.url ?? '/', 'http://token-gate.invalid')
  } catch {
    return undefined
  }
}

function parseAuthority(authority: string, scheme = 'http:'): URL | undefined {
  try {
    const url = new URL(`${scheme}//${authority}`)
    if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined
    return url.hostname.length > 0 ? url : undefined
  } catch {
    return undefined
  }
}

function isPrefixPath(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

export function createAccessPolicy(config: Config): AccessPolicy {
  const trustedProxies = new IpSet(config.trustedProxies)

  function peerIp(req: IncomingMessage): string {
    const peer = normalizeIp(req.socket.remoteAddress)
    return isIP(peer) === 0 ? '' : peer
  }

  function isSecure(req: IncomingMessage): boolean {
    const peer = peerIp(req)
    if (peer.length === 0 || !trustedProxies.has(peer)) return false
    const proto = firstHeader(req.headers, 'x-forwarded-proto')
    if (proto === undefined) return false
    const values = proto.split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
    return values.at(-1) === 'https'
  }

  function requestAuthority(req: IncomingMessage): string | undefined {
    const host = firstHeader(req.headers, 'host')
    if (host === undefined) return undefined
    const hostUrl = parseAuthority(host, isSecure(req) ? 'https:' : 'http:')
    return hostUrl?.host
  }

  function bootstrapToken(req: IncomingMessage): string | undefined {
    const url = requestUrl(req)
    if (url === undefined || url.pathname !== '/') return undefined
    const token = url.searchParams.get('token')
    return token === null || token.length === 0 ? undefined : token
  }

  function isBrowserTrusted(req: IncomingMessage): boolean {
    const host = firstHeader(req.headers, 'host')
    if (host === undefined || parseAuthority(host) === undefined) return false
    if (firstHeader(req.headers, 'sec-fetch-site')?.toLowerCase() === 'cross-site') return false
    const origin = firstHeader(req.headers, 'origin')
    if (origin === undefined) return true
    try {
      const originUrl = new URL(origin)
      if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return false
      const hostUrl = parseAuthority(host, originUrl.protocol)
      return hostUrl !== undefined && originUrl.host === hostUrl.host
    } catch {
      return false
    }
  }

  return {
    bootstrapToken,
    cleanBootstrapLocation(req) {
      const url = requestUrl(req)
      if (url === undefined) return '/'
      url.searchParams.delete('token')
      const query = url.searchParams.toString()
      return `${url.pathname}${query.length > 0 ? `?${query}` : ''}`
    },
    isSecure,
    requestAuthority,
    isBrowserTrusted,
    isHostAdminPath(req) {
      const url = requestUrl(req)
      return url !== undefined && isPrefixPath(url.pathname, HOST_ADMIN_PREFIX)
    },
    isPairingPath(req) {
      const url = requestUrl(req)
      return url !== undefined && isPrefixPath(url.pathname, PAIRING_PREFIX)
    },
  }
}
