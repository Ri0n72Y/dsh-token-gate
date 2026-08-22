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

const REQUEST_BASE = new URL('http://token-gate.invalid')

function requestUrl(req: IncomingMessage): URL | undefined {
  const raw = req.url ?? '/'
  // The gateway is an origin server, not a forward proxy. Restrict the public
  // surface to origin-form request targets and keep scheme-relative/absolute
  // targets away from WHATWG authority rewriting.
  if (!raw.startsWith('/') || raw.startsWith('//')) return undefined
  try {
    const url = new URL(raw, REQUEST_BASE)
    if (url.origin !== REQUEST_BASE.origin || url.hash !== '') return undefined
    return url
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

function configuredPort(entry: string, entryUrl: URL): string | undefined {
  if (entryUrl.port !== '') return entryUrl.port
  const httpsPort = new URL(`https://${entry}`).port
  return httpsPort === '' ? undefined : httpsPort
}

function canonicalConfiguredAuthority(entry: string, entryUrl: URL): string {
  const port = configuredPort(entry, entryUrl)
  return port === undefined ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

function assertTrustedAuthority(entry: string): void {
  const entryUrl = parseAuthority(entry)
  if (entryUrl !== undefined && canonicalConfiguredAuthority(entry, entryUrl) === entry.toLowerCase()) return
  throw new Error(`token-gate: trustedHosts entry ${JSON.stringify(entry)} is not a canonical host[:port] authority`)
}

function effectivePort(url: URL): string {
  if (url.port !== '') return url.port
  return url.protocol === 'https:' ? '443' : '80'
}

function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined || entryUrl.hostname !== hostUrl.hostname) return false
    const port = configuredPort(entry, entryUrl)
    return port === undefined || port === effectivePort(hostUrl)
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
    const raw = req.url ?? '/'
    const queryIndex = raw.indexOf('?')
    const rawPath = queryIndex === -1 ? raw : raw.slice(0, queryIndex)
    if (rawPath !== '/') return undefined
    const url = requestUrl(req)
    if (url === undefined) return undefined
    const token = url.searchParams.get('token')
    return token === null || token.length === 0 ? undefined : token
  }

  function isBrowserTrusted(req: IncomingMessage): boolean {
    const host = firstHeader(req.headers, 'host')
    if (host === undefined) return false
    const protocol = isSecure(req) ? 'https:' : 'http:'
    const hostUrl = parseAuthority(host, protocol)
    if (hostUrl === undefined) return false
    if (firstHeader(req.headers, 'sec-fetch-site')?.trim().toLowerCase() === 'cross-site') return false
    const origin = firstHeader(req.headers, 'origin')
    if (origin === undefined) return true
    try {
      const originUrl = new URL(origin)
      if (originUrl.protocol !== protocol) return false
      if (originUrl.username !== '' || originUrl.password !== '' || originUrl.pathname !== '/' || originUrl.search !== '' || originUrl.hash !== '') return false
      return originUrl.host === hostUrl.host
    } catch {
      return false
    }
  }

  function isAllowlistAuthorityTrusted(req: IncomingMessage): boolean {
    const host = firstHeader(req.headers, 'host')
    if (host === undefined) return false
    const hostUrl = parseAuthority(host, isSecure(req) ? 'https:' : 'http:')
    if (hostUrl === undefined) return false
    if (isLoopbackHostname(hostUrl.hostname) || isIpLiteralHostname(hostUrl.hostname)) return true
    return isTrustedAuthority(hostUrl, config.trustedHosts)
  }

  return {
    decide(req) {
      if (requestUrl(req) === undefined) return 'deny'
      const token = bootstrapToken(req)
      if (token !== undefined) {
        return requestAuthority(req) !== undefined && isBrowserTrusted(req) ? 'bootstrap' : 'deny'
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
