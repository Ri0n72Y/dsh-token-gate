import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { AuthorizationRepository } from './authorization.ts'
import { createAuthService } from './auth.ts'
import type { Config } from './config.ts'
import { createAccessPolicy, PAIRING_PREFIX } from './access.ts'
import { createPairingService } from './pairing.ts'
import { proxyHttp, proxyUpgrade } from './proxy.ts'
import type { Logger, UpstreamTarget } from './proxy.ts'
import { createDeviceSessionService } from './session.ts'

const NOT_FOUND_BODY = '404 page not found\n'
const PAIRING_WAIT_PATH = `${PAIRING_PREFIX}/wait`
const PAIRING_STATUS_PATH = `${PAIRING_PREFIX}/status`

export interface Gateway {
  readonly server: Server
  listen(): Promise<void>
  close(): Promise<void>
}

export interface GatewayOptions {
  config: Config
  token: string
  upstream: UpstreamTarget
  repository: AuthorizationRepository
  logger: Logger
  now?: () => number
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

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  res.end(text)
}

function waitPage(returnTo: string): string {
  const target = JSON.stringify(returnTo).replace(/</g, '\\u003c')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Waiting for host approval</title></head><body><main><h1>Waiting for host approval</h1><p>This device has requested access to DSH.</p><p id="status">Approve it from the host's local Token Gate settings.</p></main><script>const target=${target};const status=document.getElementById('status');async function poll(){try{const r=await fetch('${PAIRING_STATUS_PATH}',{cache:'no-store'});if(r.status===200){const j=await r.json();if(j.state==='approved'){location.replace(target);return}}if(r.status===202){setTimeout(poll,1500);return}status.textContent='This authorization request was rejected or expired.'}catch{setTimeout(poll,2000)}}poll();</script></body></html>`
}

function requestPath(req: IncomingMessage): string | undefined {
  try {
    return new URL(req.url ?? '/', 'http://token-gate.invalid').pathname
  } catch {
    return undefined
  }
}

function browserDescription(req: IncomingMessage): string | undefined {
  const value = req.headers['user-agent']
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  return value.trim().slice(0, 200)
}

export function createGateway(options: GatewayOptions): Gateway {
  const { config, token, upstream, repository, logger } = options
  const now = options.now ?? Date.now
  const auth = createAuthService(config, token)
  const access = createAccessPolicy(config)
  const pairing = createPairingService(config, auth, repository, now)
  const sessions = createDeviceSessionService(config, auth, repository, now)
  const sockets = new Set<Socket>()
  const pairingTtlSeconds = config.pendingTtlMinutes * 60

  async function handlePairing(req: IncomingMessage, res: ServerResponse, authority: string): Promise<boolean> {
    const path = requestPath(req)
    if (path === PAIRING_WAIT_PATH) {
      if ((req.method ?? 'GET') !== 'GET') {
        notFound(res)
        return true
      }
      const bearer = auth.readPairingCookie(req)
      if (bearer === undefined || (await pairing.resolve(bearer, authority)).state === 'missing') {
        notFound(res)
        return true
      }
      let returnTo = '/'
      try {
        const url = new URL(req.url ?? PAIRING_WAIT_PATH, 'http://token-gate.invalid')
        const candidate = url.searchParams.get('returnTo')
        if (candidate !== null && candidate.startsWith('/') && !candidate.startsWith('//')) returnTo = candidate
      } catch {
        // malformed URLs are handled as an opaque miss below
      }
      const body = waitPage(returnTo)
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      })
      res.end(body)
      return true
    }

    if (path === PAIRING_STATUS_PATH) {
      if ((req.method ?? 'GET') !== 'GET') {
        notFound(res)
        return true
      }
      const bearer = auth.readPairingCookie(req)
      if (bearer === undefined) {
        notFound(res)
        return true
      }
      const resolved = await pairing.resolve(bearer, authority)
      if (resolved.state === 'missing') {
        notFound(res)
        return true
      }
      if (resolved.state === 'pending') {
        json(res, 202, { state: 'pending' })
        return true
      }
      const issued = await sessions.issueApprovedSession(
        bearer,
        resolved.id,
        resolved.record,
        access.isSecure(req),
      )
      json(res, 200, { state: 'approved' }, {
        'Set-Cookie': [issued.cookie, auth.clearPairingCookie(access.isSecure(req))],
      })
      return true
    }

    if (access.isPairingPath(req)) {
      notFound(res)
      return true
    }
    return false
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const authority = access.requestAuthority(req)
    if (authority === undefined || !access.isBrowserTrusted(req) || access.isHostAdminPath(req)) {
      notFound(res)
      return
    }

    const submitted = access.bootstrapToken(req)
    if (submitted !== undefined) {
      if ((req.method ?? 'GET') !== 'GET' || !auth.authorizeBootstrap(`peer:${access.rateKey(req)}`, submitted)) {
        notFound(res)
        return
      }
      const requested = await pairing.request(
        authority,
        browserDescription(req),
        auth.readPairingCookie(req),
      )
      const clean = access.cleanBootstrapLocation(req)
      const location = `${PAIRING_WAIT_PATH}?returnTo=${encodeURIComponent(clean)}`
      res.writeHead(303, {
        'Set-Cookie': auth.pairingCookie(requested.bearer, access.isSecure(req), pairingTtlSeconds),
        'Location': location,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Length': '0',
      })
      res.end()
      return
    }

    if (await handlePairing(req, res, authority)) return

    const decision = await sessions.validate(auth.readSessionCookie(req), authority, access.isSecure(req))
    if (!decision.allowed) {
      notFound(res)
      return
    }
    if (decision.renewalError !== undefined) {
      logger.warn('token-gate: session renewal failed: %s', String(decision.renewalError))
    }
    proxyHttp(req, res, upstream, auth, logger, decision.refreshCookie)
  }

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const authority = access.requestAuthority(req)
    if (
      authority === undefined
      || !access.isBrowserTrusted(req)
      || access.isHostAdminPath(req)
      || access.isPairingPath(req)
      || access.bootstrapToken(req) !== undefined
    ) {
      socket.destroy()
      return
    }
    const decision = await sessions.validate(auth.readSessionCookie(req), authority, access.isSecure(req))
    if (!decision.allowed) {
      socket.destroy()
      return
    }
    if (decision.renewalError !== undefined) {
      logger.warn('token-gate: WebSocket session renewal failed: %s', String(decision.renewalError))
    }
    proxyUpgrade(req, socket, head, upstream, auth, logger, decision.refreshCookie)
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      logger.warn('token-gate: request handling error: %s', String(error))
      if (res.headersSent) res.destroy()
      else notFound(res)
    })
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', (error) => logger.warn('token-gate: client socket error: %s', String(error)))
  })

  server.on('upgrade', (req, socket, head) => {
    void handleUpgrade(req, socket, head).catch((error) => {
      logger.warn('token-gate: upgrade handling error: %s', String(error))
      socket.destroy()
    })
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
      const socketClosures = [...sockets].map(socket => new Promise<void>((resolve) => {
        socket.once('close', () => resolve())
        socket.destroy()
      }))
      const serverClosed = server.listening
        ? new Promise<void>((resolve) => { server.close(() => resolve()) })
        : Promise.resolve()
      await Promise.all([serverClosed, ...socketClosures])
    },
  }
}
