import { request as httpRequest } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { AuthService } from './auth.ts'

export interface UpstreamTarget {
  host: string
  port: number
}

export interface Logger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const PROXY_IDENTITY_HEADERS = new Set([
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'cf-connecting-ip',
  'cf-visitor',
])

function headerTokens(value: string | string[] | undefined): Set<string> {
  const raw = Array.isArray(value) ? value.join(',') : value
  if (raw === undefined) return new Set()
  return new Set(raw.split(',').map(item => item.trim().toLowerCase()).filter(Boolean))
}

export function forwardHeaders(
  req: IncomingMessage,
  target: UpstreamTarget,
  auth: AuthService,
  keepUpgrade: boolean,
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {}
  const declaredHop = headerTokens(req.headers.connection)

  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase()
    if (lower === 'host' || lower === 'origin' || lower === 'expect' || PROXY_IDENTITY_HEADERS.has(lower)) continue
    if (declaredHop.has(lower) || HOP_BY_HOP.has(lower)) continue
    if (lower === 'cookie' && typeof value === 'string') {
      const cookie = auth.stripSessionCookie(value)
      if (cookie !== undefined) out[key] = cookie
      continue
    }
    out[key] = value
  }

  out.host = `${target.host}:${target.port}`
  if (typeof req.headers.origin === 'string') out.origin = `http://${target.host}:${target.port}`
  if (keepUpgrade) {
    out.connection = 'Upgrade'
    out.upgrade = 'websocket'
  }
  return out
}

export function sanitizeResponseHeaders(
  headers: IncomingHttpHeaders,
  auth?: AuthService,
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {}
  const declaredHop = headerTokens(headers.connection)
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (HOP_BY_HOP.has(lower) || declaredHop.has(lower)) continue
    if (lower === 'set-cookie' && value !== undefined && auth !== undefined) {
      const cookies = auth.stripSessionSetCookies(value)
      if (cookies !== undefined) out[key] = cookies
      continue
    }
    out[key] = value
  }
  return out
}

function appendHeaders(
  lines: string[],
  headers: Record<string, string | string[] | undefined>,
): void {
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${name}: ${item}`)
    } else {
      lines.push(`${name}: ${value}`)
    }
  }
}

function writeSocketResponse(
  socket: Duplex,
  statusCode: number,
  statusMessage: string,
  headers: Record<string, string | string[] | undefined>,
): void {
  const lines = [`HTTP/1.1 ${statusCode} ${statusMessage}`]
  appendHeaders(lines, headers)
  lines.push('Connection: close')
  socket.write(`${lines.join('\r\n')}\r\n\r\n`)
}

function destroyResponse(res: ServerResponse): void {
  if (!res.destroyed && !res.writableEnded) res.destroy()
}

export function proxyHttp(
  req: IncomingMessage,
  res: ServerResponse,
  target: UpstreamTarget,
  auth: AuthService,
  logger: Logger,
): void {
  const upstream = httpRequest({
    host: target.host,
    port: target.port,
    method: req.method,
    path: req.url,
    headers: forwardHeaders(req, target, auth, false),
  }, (upstreamRes) => {
    if (res.destroyed) {
      upstreamRes.destroy()
      return
    }

    upstreamRes.on('aborted', () => {
      logger.warn('token-gate: upstream response aborted')
      destroyResponse(res)
    })
    upstreamRes.on('error', (error) => {
      logger.warn('token-gate: upstream response error: %s', String(error))
      destroyResponse(res)
    })

    res.writeHead(upstreamRes.statusCode ?? 502, sanitizeResponseHeaders(upstreamRes.headers, auth))
    upstreamRes.pipe(res)
    res.on('close', () => {
      if (!upstreamRes.destroyed) upstreamRes.destroy()
    })
  })

  upstream.on('error', (error) => {
    logger.warn('token-gate: upstream error: %s', String(error))
    if (res.destroyed) return
    if (!res.headersSent) {
      res.writeHead(502)
      res.end()
    } else {
      destroyResponse(res)
    }
  })

  req.on('aborted', () => upstream.destroy())
  req.on('error', () => upstream.destroy())
  req.pipe(upstream)
  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy()
  })
}

export function proxyUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: UpstreamTarget,
  auth: AuthService,
  logger: Logger,
): void {
  const upstream = httpRequest({
    host: target.host,
    port: target.port,
    method: req.method,
    path: req.url,
    headers: forwardHeaders(req, target, auth, true),
  })

  upstream.on('upgrade', (upstreamRes: IncomingMessage, upstreamSocket: Duplex, upstreamHead: Buffer) => {
    const lines = [`HTTP/1.1 101 ${upstreamRes.statusMessage ?? 'Switching Protocols'}`]
    appendHeaders(lines, sanitizeResponseHeaders(upstreamRes.headers, auth))
    lines.push('Connection: Upgrade', 'Upgrade: websocket')
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (upstreamHead.length > 0) socket.write(upstreamHead)
    if (head.length > 0) upstreamSocket.write(head)
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
    socket.on('error', () => upstreamSocket.destroy())
    upstreamSocket.on('error', () => socket.destroy())
    socket.on('close', () => upstreamSocket.destroy())
    upstreamSocket.on('close', () => socket.destroy())
  })

  upstream.on('response', (upstreamRes) => {
    if (socket.destroyed) {
      upstreamRes.destroy()
      return
    }
    upstreamRes.on('aborted', () => socket.destroy())
    upstreamRes.on('error', (error) => {
      logger.warn('token-gate: upstream upgrade response error: %s', String(error))
      socket.destroy()
    })
    writeSocketResponse(
      socket,
      upstreamRes.statusCode ?? 502,
      upstreamRes.statusMessage ?? 'Bad Gateway',
      sanitizeResponseHeaders(upstreamRes.headers, auth),
    )
    upstreamRes.pipe(socket, { end: true })
  })

  upstream.on('error', (error) => {
    logger.warn('token-gate: upstream upgrade error: %s', String(error))
    socket.destroy()
  })

  socket.on('close', () => upstream.destroy())
  upstream.end()
}
