/**
 * dsh-token-gate — sidecar gateway for DeepSeek Harness.
 *
 * The plugin owns an independent HTTP port and stands in front of the dsh web
 * server. Every request that is not loopback-hosted, not from an allowlisted
 * IP, and not carrying a valid HttpOnly session cookie is answered with a
 * plain 404 page (the dsh server never sees it). Authorized requests are
 * reverse-proxied to the local dsh webserver, with the Host header rewritten
 * to the loopback target and the Origin header stripped, so dsh's own browser
 * trust fence accepts the forwarded request without any `--trusted-host`
 * configuration.
 *
 * Share-link flow:
 *   http://host:port/#token=ABC
 *     -> browser GETs "/" (fragment never reaches the server)
 *     -> gateway answers 404 (a disguised page that runs a hidden bootstrap
 *        script when a fragment token is present)
 *     -> script POSTs /api/auth/bootstrap -> HttpOnly cookie
 *     -> reload -> cookie present -> gateway proxies to dsh
 *
 * @module dsh-token-gate
 */

import { createServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'token-gate'

export interface Config {
  /** Pre-shared bootstrap token. Prefer the DSH_AUTH_TOKEN env for secrets. */
  token?: string
  /** HttpOnly session cookie name. */
  cookieName: string
  /** Session lifetime in days. */
  sessionTtlDays: number
  /** Max bootstrap attempts per client inside one rate window. */
  rateMax: number
  /** Rate-limit window in minutes. */
  rateWindowMinutes: number
  /** Source IPs (or CIDR blocks) allowed through without a session. */
  allowIps: string[]
  /** Gateway bind address. '0.0.0.0' exposes the gateway to the network. */
  bind: '0.0.0.0' | '127.0.0.1'
  /** Gateway listen port (external entry; point cloudflared/caddy here). */
  port: number
}

export const Config: Schema<Config> = Schema.object({
  // schemastery object fields are OPTIONAL by default; `.required()` marks a
  // field mandatory. There is no `.optional()` in schemastery.
  token: Schema.string(),
  cookieName: Schema.string().default('dsh_session'),
  sessionTtlDays: Schema.natural().min(1).max(365).default(30),
  rateMax: Schema.natural().min(1).default(10),
  rateWindowMinutes: Schema.natural().min(1).default(15),
  allowIps: Schema.array(String).default([]),
  bind: Schema.union([Schema.const('0.0.0.0'), Schema.const('127.0.0.1')]).default('0.0.0.0'),
  port: Schema.natural().min(1).max(65535).default(3081),
})

/** Hard dependency: the dsh webserver (only its listening port is read). */
export const inject = ['webServer']

interface TokenGateWebServer {
  readonly port: number
}

const AUTH_PREFIX = '/api/auth'
const BOOTSTRAP_PATH = `${AUTH_PREFIX}/bootstrap`
const STATUS_PATH = `${AUTH_PREFIX}/status`
const LOGOUT_PATH = `${AUTH_PREFIX}/logout`
const MAX_BODY_BYTES = 8192
const RATE_CLEANUP_THRESHOLD = 2000

/** The disguised 404 page. Looks like a plain upstream miss; the bootstrap
 * script inside is invisible unless the URL carries a `#token=` fragment. */
const NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>404 Not Found</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #fafafa; color: #444; margin: 0; }
  .wrap { max-width: 560px; margin: 96px auto 0; padding: 0 24px; }
  h1 { font-size: 28px; font-weight: 600; }
  hr { border: none; border-top: 1px solid #ddd; margin: 24px 0; }
  p { font-size: 15px; line-height: 1.6; }
  code { background: #f0f0f0; padding: 1px 5px; border-radius: 3px; }
</style>
</head>
<body>
<div class="wrap">
<h1>404 Not Found</h1>
<hr>
<p>The requested URL was not found on this server.</p>
</div>
<script>
(function () {
  var token = null;
  try { token = new URLSearchParams(window.location.hash.slice(1)).get('token'); } catch (e) {}
  if (!token) return;
  fetch('/api/auth/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ token: token })
  }).then(function (r) {
    if (!r.ok) return;
    try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) {}
    window.location.reload();
  }).catch(function () {});
})();
</script>
</body>
</html>
`

export function apply(ctx: Context, config: Config): void {
  const webServer = ctx.get('webServer') as TokenGateWebServer | undefined
  if (webServer === undefined) {
    throw new Error('token-gate: webServer is unavailable')
  }
  const targetHost = '127.0.0.1'
  const targetPort = webServer.port

  const token = resolveToken(config)
  if (token.source === 'generated') {
    ctx.logger.warn(`token-gate: no token configured and DSH_AUTH_TOKEN unset — generated access token: ${token.value}`)
  } else {
    ctx.logger.info(`token-gate: bootstrap token from ${token.source}`)
  }

  const ttlMs = config.sessionTtlDays * 24 * 60 * 60 * 1000
  const rateWindowMs = config.rateWindowMinutes * 60 * 1000

  // In-memory session store; every session dies with the process.
  const sessions = new Map<string, { createdAt: number; expiresAt: number }>()
  const attempts = new Map<string, number[]>()

  // ── classification helpers ──────────────────────────────────────────────

  function hostnameOf(authority: string): string {
    if (authority.length === 0) return ''
    if (authority[0] === '[') {
      const end = authority.indexOf(']')
      return (end === -1 ? authority : authority.slice(0, end + 1)).toLowerCase()
    }
    const colon = authority.lastIndexOf(':')
    if (colon === -1) return authority.toLowerCase()
    const port = authority.slice(colon + 1)
    if (/^\d+$/.test(port)) return authority.slice(0, colon).toLowerCase()
    return authority.toLowerCase()
  }

  function isLoopbackHost(authority: string): boolean {
    const host = hostnameOf(authority)
    if (host === 'localhost' || host === '[::1]') return true
    const parts = host.split('.')
    return parts.length === 4
      && parts[0] === '127'
      && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  }

  function isLoopbackIp(addr: string | undefined): boolean {
    if (addr === undefined) return false
    return addr === '::1' || addr === '0:0:0:0:0:0:0:1'
      || addr.startsWith('127.') || addr.startsWith('::ffff:127.')
  }

  function firstHeader(headers: IncomingMessage['headers'], name: string): string | undefined {
    const value = headers[name]
    if (typeof value === 'string') return value
    if (Array.isArray(value) && value.length > 0) return value[0]
    return undefined
  }

  /**
   * The client IP to judge the allowlist against. When the peer socket is
   * loopback but the Host is not (traffic arrived through a local trusted
   * proxy such as cloudflared), trust CF-Connecting-IP, then the first
   * X-Forwarded-For hop. Otherwise use the socket address directly so a
   * direct attacker cannot forge the allowlist through spoofed headers.
   */
  function clientIp(req: IncomingMessage): string {
    const socket = req.socket.remoteAddress ?? ''
    const host = firstHeader(req.headers, 'host') ?? ''
    if (isLoopbackIp(socket) && !isLoopbackHost(host)) {
      const cf = firstHeader(req.headers, 'cf-connecting-ip')
      if (cf !== undefined && cf.length > 0) return cf
      const xff = firstHeader(req.headers, 'x-forwarded-for')
      if (xff !== undefined) {
        const first = xff.split(',')[0].trim()
        if (first.length > 0) return first
      }
    }
    return socket
  }

  function ipv4ToInt(ip: string): number | null {
    const parts = ip.split('.')
    if (parts.length !== 4) return null
    let value = 0
    for (const part of parts) {
      if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null
      value = (value << 8) | Number(part)
    }
    return value >>> 0
  }

  function ipAllowed(ip: string): boolean {
    const int = ipv4ToInt(ip)
    if (int === null) return false
    return config.allowIps.some((entry) => {
      const [net, bitsText] = entry.split('/')
      const bits = bitsText === undefined ? 32 : Number(bitsText)
      if (bits < 0 || bits > 32) return false
      const netInt = ipv4ToInt(net)
      if (netInt === null) return false
      const mask = bits === 0 ? 0 : ((~0 << (32 - bits)) >>> 0)
      return (int & mask) === (netInt & mask)
    })
  }

  function pathOf(req: IncomingMessage): string {
    const raw = req.url ?? '/'
    const query = raw.indexOf('?')
    return query === -1 ? raw : raw.slice(0, query)
  }

  function isAuthPath(path: string): boolean {
    return path === BOOTSTRAP_PATH || path === STATUS_PATH || path === LOGOUT_PATH
  }

  /** Gateway decision: allow (proxy), auth-path (handle locally), or deny (404). */
  function gatewayDecision(req: IncomingMessage): 'allow' | 'auth-path' | 'deny' {
    const host = firstHeader(req.headers, 'host') ?? ''
    if (isLoopbackHost(host)) return 'allow'
    // Auth endpoints are always owned by the gateway, session or allowlist
    // notwithstanding: logout must revoke, bootstrap must mint.
    if (isAuthPath(pathOf(req))) return 'auth-path'
    if (getSession(readCookie(req, config.cookieName)) !== undefined) return 'allow'
    if (ipAllowed(clientIp(req))) return 'allow'
    return 'deny'
  }

  // ── sessions ────────────────────────────────────────────────────────────

  function prune(): void {
    const now = Date.now()
    for (const [id, session] of sessions) {
      if (now > session.expiresAt) sessions.delete(id)
    }
    if (attempts.size > RATE_CLEANUP_THRESHOLD) {
      for (const [key, list] of attempts) {
        const kept = list.filter(timestamp => now - timestamp < rateWindowMs)
        if (kept.length === 0) attempts.delete(key)
        else attempts.set(key, kept)
      }
    }
  }

  function createSession(): string {
    prune()
    const now = Date.now()
    const id = randomUUID()
    sessions.set(id, { createdAt: now, expiresAt: now + ttlMs })
    return id
  }

  function getSession(id: string | undefined): { createdAt: number; expiresAt: number } | undefined {
    if (id === undefined || id.length === 0) return undefined
    const session = sessions.get(id)
    if (session === undefined) return undefined
    if (Date.now() > session.expiresAt) {
      sessions.delete(id)
      return undefined
    }
    return session
  }

  // ── bootstrap rate limiting ─────────────────────────────────────────────

  function clientKey(req: IncomingMessage): string {
    return `ip:${clientIp(req)}`
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
    return true
  }

  // ── request helpers ─────────────────────────────────────────────────────

  function readCookie(req: IncomingMessage, cookieName: string): string | undefined {
    const raw = req.headers['cookie']
    if (typeof raw !== 'string') return undefined
    for (const part of raw.split(';')) {
      const eq = part.indexOf('=')
      if (eq === -1) continue
      if (part.slice(0, eq).trim() === cookieName) return part.slice(eq + 1).trim()
    }
    return undefined
  }

  async function readBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
    const chunks: Buffer[] = []
    let received = 0
    for await (const chunk of req) {
      const buffer = chunk as Buffer
      received += buffer.byteLength
      if (received > maxBytes) return null
      chunks.push(buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  function isSecureRequest(req: IncomingMessage): boolean {
    const proto = firstHeader(req.headers, 'x-forwarded-proto')
    if (proto !== undefined && proto.toLowerCase().split(',')[0].trim() === 'https') return true
    const cf = firstHeader(req.headers, 'cf-visitor')
    if (cf !== undefined) {
      try {
        const value: unknown = JSON.parse(cf)
        if (value !== null && typeof value === 'object' && (value as { scheme?: unknown }).scheme === 'https') return true
      } catch {
        // not JSON — ignore
      }
    }
    return false
  }

  function safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a, 'utf8')
    const right = Buffer.from(b, 'utf8')
    if (left.length !== right.length) return false
    return timingSafeEqual(left, right)
  }

  function json(res: ServerResponse, status: number, body: unknown): void {
    if (res.destroyed) return
    try {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(JSON.stringify(body))
    } catch {
      // socket already gone
    }
  }

  function sessionCookie(id: string, secure: boolean): string {
    const base = `${config.cookieName}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(ttlMs / 1000)}`
    return secure ? `${base}; Secure` : base
  }

  function clearCookie(): string {
    return `${config.cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
  }

  // ── auth endpoints (owned by the gateway) ───────────────────────────────

  async function handleAuth(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = pathOf(req)
    const method = req.method ?? 'GET'
    try {
      if (path === BOOTSTRAP_PATH && method === 'POST') {
        const key = clientKey(req)
        if (!allowAttempt(key)) {
          json(res, 429, { error: 'rate_limited' })
          return
        }
        const body = await readBody(req, MAX_BODY_BYTES)
        if (body === null) {
          json(res, 400, { error: 'bad_request' })
          return
        }
        let submitted: unknown
        try {
          submitted = (JSON.parse(body) as { token?: unknown }).token
        } catch {
          json(res, 400, { error: 'bad_json' })
          return
        }
        if (typeof submitted !== 'string' || !safeEqual(submitted, token.value)) {
          json(res, 401, { error: 'invalid_token' })
          return
        }
        const id = createSession()
        res.setHeader('Set-Cookie', sessionCookie(id, isSecureRequest(req)))
        json(res, 200, { ok: true, ttlDays: config.sessionTtlDays })
        return
      }
      if (path === STATUS_PATH && method === 'GET') {
        prune()
        const sessionId = readCookie(req, config.cookieName)
        json(res, 200, { authenticated: getSession(sessionId) !== undefined })
        return
      }
      if (path === LOGOUT_PATH && method === 'POST') {
        const sessionId = readCookie(req, config.cookieName)
        if (sessionId !== undefined) sessions.delete(sessionId)
        res.setHeader('Set-Cookie', clearCookie())
        json(res, 200, { ok: true })
        return
      }
      json(res, 404, { error: 'not_found' })
    } catch {
      try {
        json(res, 500, { error: 'internal' })
      } catch {
        // socket already gone
      }
    }
  }

  // ── reverse proxy ───────────────────────────────────────────────────────

  function forwardHeaders(req: IncomingMessage, keepUpgrade: boolean): Record<string, string | string[] | undefined> {
    const out: Record<string, string | string[] | undefined> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase()
      // Host and Origin are always rewritten/stripped by the gateway.
      if (lower === 'host' || lower === 'origin') continue
      // Hop-by-hop headers: keep Upgrade/Connection for upgrade forwarding,
      // drop them (and the rest) on plain HTTP.
      if (!keepUpgrade && (lower === 'connection' || lower === 'upgrade' || lower === 'te' || lower === 'trailer' || lower === 'transfer-encoding')) continue
      if (lower === 'proxy-authenticate' || lower === 'proxy-authorization' || lower === 'keep-alive') continue
      out[key] = value
    }
    // Rewrite Host to the loopback target so dsh's trust fence sees a
    // loopback authority; Origin is stripped so the fence's origin check
    // cannot reject the forwarded browser request. Authentication is the
    // gateway's job now.
    out['host'] = `${targetHost}:${targetPort}`
    return out
  }

  function proxy(req: IncomingMessage, res: ServerResponse): void {
    const upstream = httpRequest({
      host: targetHost,
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req, false),
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    })
    upstream.on('error', (error) => {
      ctx.logger.warn('token-gate: upstream error: %s', String(error))
      if (!res.headersSent) {
        res.writeHead(502)
        res.end()
      } else {
        res.destroy()
      }
    })
    // Stream the request body upstream and tear down on client disconnect.
    req.pipe(upstream)
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy()
    })
  }

  function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const upstream = httpRequest({
      host: targetHost,
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req, true),
    })
    upstream.on('upgrade', (upstreamRes: IncomingMessage, upstreamSocket: Duplex, upstreamHead: Buffer) => {
      const lines = [`HTTP/1.1 101 ${upstreamRes.statusMessage ?? 'Switching Protocols'}`]
      const raw = upstreamRes.rawHeaders
      for (let i = 0; i + 1 < raw.length; i += 2) lines.push(`${raw[i]}: ${raw[i + 1] ?? ''}`)
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upstreamHead.length > 0) socket.write(upstreamHead)
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
      // Pipes do not react to destroy; tear the peer down on either close so
      // no half-open socket survives (and server close can settle).
      socket.on('error', () => upstreamSocket.destroy())
      upstreamSocket.on('error', () => socket.destroy())
      socket.on('close', () => upstreamSocket.destroy())
      upstreamSocket.on('close', () => socket.destroy())
    })
    upstream.on('error', (error) => {
      ctx.logger.warn('token-gate: upstream upgrade error: %s', String(error))
      socket.destroy()
    })
    if (head.length > 0) upstream.write(head)
    upstream.end()
  }

  function notFound(res: ServerResponse): void {
    if (res.destroyed) return
    try {
      res.writeHead(404, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(NOT_FOUND_HTML)
    } catch {
      // socket already gone
    }
  }

  // ── gateway server ──────────────────────────────────────────────────────

  ctx.effect(() => {
    const server = createServer((req, res) => {
      const decision = gatewayDecision(req)
      if (decision === 'deny') {
        notFound(res)
        return
      }
      if (decision === 'auth-path') {
        void handleAuth(req, res)
        return
      }
      proxy(req, res)
    })
    server.on('upgrade', (req, socket, head) => {
      const decision = gatewayDecision(req)
      if (decision !== 'allow') {
        socket.destroy()
        return
      }
      proxyUpgrade(req, socket, head)
    })
    server.on('error', (error) => {
      ctx.logger.error('token-gate: gateway error: %s', String(error))
    })
    server.listen(config.port, config.bind, () => {
      ctx.logger.info(`token-gate: gateway listening on ${config.bind}:${String(config.port)}, proxying to ${targetHost}:${String(targetPort)}`)
    })
    return () => {
      server.close()
      server.closeAllConnections()
    }
  }, 'token-gate: gateway server')

  ctx.logger.info(`token-gate: active — non-allowlisted remote entry answers 404; session cookie "${config.cookieName}", ${config.sessionTtlDays} days`)
}

/** Resolve the bootstrap token: config → DSH_AUTH_TOKEN env → random + log. */
function resolveToken(config: Config): { value: string; source: 'config' | 'env' | 'generated' } {
  if (config.token !== undefined && config.token.length > 0) return { value: config.token, source: 'config' }
  const env = process.env.DSH_AUTH_TOKEN
  if (env !== undefined && env.length > 0) return { value: env, source: 'env' }
  return { value: randomBytes(16).toString('hex'), source: 'generated' }
}
