import { isIP } from 'node:net'
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
  requestAuthority(req: IncomingMessage): string | undefined
  isBrowserTrusted(req: IncomingMessage): boolean
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

function canonicalConfiguredAuthority(entry: string, entryUrl: URL): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

function assertTrustedAuthority(entry: string): void {
  const entryUrl = parseAuthority(entry)
  if (entryUrl !== undefined && canonicalConfiguredAuthority(entry, entryUrl) === entry.toLowerCase()) return
  throw new Error(`token-gate: trustedHosts entry ${JSON.stringify(entry)} is not a canonical host[:port] authority`)
}

function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalConfiguredAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname.toLowerCase() === 'localhost') return true
  const ip = normalizeIp(hostname)
  if (ip === '::1') return true
  return isIP(ip) === 4 && ip.startsWith('127.')
}

function isIpLiteralHostname(hostname: string): boolean {
  return isIP(normalizeIp(hostname)) !== 0
}

export function createAccessPolicy(config: Config, auth: AuthService): AccessPolicy {
  const allowedIps = new IpSet(config.allowIps)
  const trustedProxies = new IpSet(config.trustedProxies)
  for (const entry of config.trustedHosts) assertTrustedAuthority(entry)

  function peerIp(req: IncomingMessage): string {
    const peer = normalizeIp(req.socket.remoteAddress)
    return isIP(peer) === 0 ? '' : peer
  }

  function forwardedForClient(req: IncomingMessage, peer: string): string {
    const raw = firstHeader(req.headers, 'x-forwarded-for')
    if (raw === undefined || raw.trim().length === 0) return ''
    const chain = raw.split(',').map(value => normalizeIp(value))
    if (chain.some(value => isIP(value) === 0)) return ''
    chain.push(peer)
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      if (!trustedProxies.has(chain[index])) return chain[index]
    }
    return chain[0] ?? ''
  }

  function clientIp(req: IncomingMessage): string {
    const peer = peerIp(req)
    if (peer.length === 0) return ''
    if (!trustedProxies.has(peer) || config.realIpHeader === 'none') return peer
    return forwardedForClient(req, peer)
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

  function isAllowlistAuthorityTrusted(req: IncomingMessage): boolean {
    const host = firstHeader(req.headers, 'host')
    if (host === undefined) return false
    const hostUrl = parseAuthority(host)
    if (hostUrl === undefined) return false
    if (isLoopbackHostname(hostUrl.hostname) || isIpLiteralHostname(hostUrl.hostname)) return true
    return isTrustedAuthority(hostUrl, config.trustedHosts)
  }

  return {
    decide(req) {
      if (requestUrl(req) === undefined) return 'deny'
      if (bootstrapToken(req) !== undefined) {
        const authority = requestAuthority(req)
        return authority !== undefined && isBrowserTrusted(req) ? 'bootstrap' : 'deny'
      }
      const authority = requestAuthority(req)
      if (authority === undefined || !isBrowserTrusted(req)) return 'deny'
      if (auth.hasRequestSession(req, authority)) return 'allow'
      if (allowedIps.has(clientIp(req)) && isAllowlistAuthorityTrusted(req)) return 'allow'
      return 'deny'
    },
    bootstrapToken,
    cleanBootstrapLocation(req) {
      const url = requestUrl(req)
      if (url === undefined) return '/'
      url.searchParams.delete('token')
      const query = url.searchParams.toString()
      return `${url.pathname}${query.length > 0 ? `?${query}` : ''}`
    },
    clientIp,
    isSecure,
    requestAuthority,
    isBrowserTrusted,
  }
}
