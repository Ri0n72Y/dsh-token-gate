import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { Config } from './config.ts'
import { createAuthService } from './auth.ts'
import { createAccessPolicy } from './access.ts'
import { proxyHttp, proxyUpgrade } from './proxy.ts'
import type { Logger, UpstreamTarget } from './proxy.ts'

const NOT_FOUND_BODY = '404 page not found\n'

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
    'Content-Length': Buffer.byteLength(NOT_FOUND_BODY),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(NOT_FOUND_BODY)
}

export function createGateway(options: GatewayOptions): Gateway {
  const { config, token, upstream, logger } = options
  const auth = createAuthService(config, token)
  const access = createAccessPolicy(config, auth)
  const sockets = new Set<Socket>()

  const server = createServer((req, res) => {
    const decision = access.decide(req)
    if (decision === 'deny') {
      notFound(res)
      return
    }
    if (decision === 'bootstrap') {
      if ((req.method ?? 'GET') !== 'GET') {
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
      if (sessionId === undefined) {
        logger.warn('token-gate: session capacity reached')
        notFound(res)
        return
      }
      res.writeHead(303, {
        'Set-Cookie': auth.sessionCookie(sessionId, access.isSecure(req)),
        'Location': access.cleanBootstrapLocation(req),
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Length': '0',
      })
      res.end()
      return
    }
    proxyHttp(req, res, upstream, auth, logger)
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', (error) => logger.warn('token-gate: client socket error: %s', String(error)))
  })

  server.on('upgrade', (req, socket, head) => {
    if (access.decide(req) !== 'allow') {
      socket.destroy()
      return
    }
    proxyUpgrade(req, socket, head, upstream, auth, logger)
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

    close() {
      for (const socket of sockets) socket.destroy()
      if (!server.listening) return Promise.resolve()
      return new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  }
}
