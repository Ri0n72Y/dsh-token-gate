import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { Config } from './config.ts'
import { createAuthService } from './auth.ts'
import { createAccessPolicy } from './access.ts'
import { proxyHttp, proxyUpgrade } from './proxy.ts'
import type { Logger, UpstreamTarget } from './proxy.ts'

const NOT_FOUND_BODY = '404 page not found\n'
const NOT_FOUND_LENGTH = Buffer.byteLength(NOT_FOUND_BODY)

export interface Gateway {
  readonly server: Server
  listen(): Promise<void>
  close(): Promise<void>
}

export interface GatewayOptions {
  config: Config
  token: string
  upstream: UpstreamTarget
  logger: Logger
}

function notFound(res: ServerResponse): void {
  if (res.destroyed) return
  res.writeHead(404, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': NOT_FOUND_LENGTH,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'close',
  })
  res.end(NOT_FOUND_BODY)
}

function rawNotFound(socket: Duplex): void {
  if (socket.destroyed || !socket.writable) {
    socket.destroy()
    return
  }
  socket.end([
    'HTTP/1.1 404 Not Found',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${String(NOT_FOUND_LENGTH)}`,
    'Cache-Control: no-store',
    'X-Content-Type-Options: nosniff',
    'Connection: close',
    '',
    NOT_FOUND_BODY,
  ].join('\r\n'))
}

export function createGateway(options: GatewayOptions): Gateway {
  const { config, token, upstream, logger } = options
  const auth = createAuthService(config, token)
  const access = createAccessPolicy(config, auth)
  const sockets = new Set<Socket>()

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    try {
      const decision = access.decide(req)
      if (decision === 'deny') {
        notFound(res)
        return
      }
      if (decision === 'bootstrap') {
        if ((req.method ?? 'GET') !== 'GET' || !access.isBrowserTrusted(req)) {
          notFound(res)
          return
        }
        const submitted = access.bootstrapToken(req)
        const authority = access.requestAuthority(req)
        const clientKey = access.clientIp(req) || 'unknown'
        if (submitted === undefined || authority === undefined || !auth.authorizeBootstrap(`ip:${clientKey}`, submitted)) {
          notFound(res)
          return
        }
        const sessionId = auth.createSession(authority)
        res.writeHead(303, {
          'Set-Cookie': auth.sessionCookie(sessionId),
          'Location': access.cleanBootstrapLocation(req),
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'Content-Length': '0',
        })
        res.end()
        return
      }
      proxyHttp(req, res, upstream, auth, logger)
    } catch (error) {
      logger.warn('token-gate: rejected request after internal error: %s', String(error))
      if (res.headersSent) res.destroy()
      else notFound(res)
    }
  }

  const server = createServer(handleRequest)

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', (error) => logger.warn('token-gate: client socket error: %s', String(error)))
  })

  server.on('clientError', (_error, socket) => {
    rawNotFound(socket)
  })

  server.on('upgrade', (req, socket, head) => {
    try {
      if (req.headers.upgrade?.trim().toLowerCase() !== 'websocket' || access.decide(req) !== 'allow') {
        socket.destroy()
        return
      }
      proxyUpgrade(req, socket, head, upstream, auth, logger)
    } catch (error) {
      logger.warn('token-gate: rejected upgrade after internal error: %s', String(error))
      socket.destroy()
    }
  })

  server.on('error', (error) => {
    logger.error('token-gate: gateway error: %s', String(error))
  })

  return {
    server,

    listen() {
      if (server.listening) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(config.port, config.bind)
      })
    },

    async close() {
      const socketClosures = [...sockets].map(socket => socket.destroyed
        ? Promise.resolve()
        : new Promise<void>(resolve => socket.once('close', () => resolve())))
      const serverClosed = server.listening
        ? new Promise<void>(resolve => server.close(() => resolve()))
        : Promise.resolve()
      for (const socket of sockets) socket.destroy()
      await Promise.all([serverClosed, ...socketClosures])
    },
  }
}
