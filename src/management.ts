import type { IncomingMessage, ServerResponse } from 'node:http'
import { HOST_ADMIN_PREFIX } from './access.ts'
import type { AuthorizationRepository } from './authorization.ts'

export interface DeviceManagementSnapshot {
  pending: Array<{
    id: string
    authority: string
    browser?: string
    requestedAt: number
    expiresAt: number
  }>
  devices: Array<{
    id: string
    authority: string
    browser?: string
    createdAt: number
    lastSeenAt: number
    expiresAt: number
  }>
}

export interface DeviceManagementService {
  list(): DeviceManagementSnapshot
  approve(id: string): Promise<boolean>
  reject(id: string): Promise<boolean>
  revoke(id: string): Promise<boolean>
}

export interface WebServerRouteHost {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

function sameOrigin(req: IncomingMessage): boolean {
  const host = req.headers.host
  const origin = req.headers.origin
  if (typeof host !== 'string' || host.length === 0) return false
  if (typeof origin !== 'string') return true
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(text)
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'Content-Length': '0', 'Cache-Control': 'no-store' })
  res.end()
}

export function createDeviceManagementService(repository: AuthorizationRepository): DeviceManagementService {
  return {
    list() {
      return {
        pending: repository.listPending().map(({ id, record }) => ({
          id,
          authority: record.authority,
          browser: record.browser,
          requestedAt: record.requestedAt,
          expiresAt: record.expiresAt,
        })),
        devices: repository.listDevices().map(({ id, record }) => ({
          id,
          authority: record.authority,
          browser: record.browser,
          createdAt: record.createdAt,
          lastSeenAt: record.lastSeenAt,
          expiresAt: record.expiresAt,
        })),
      }
    },

    async approve(id) {
      return await repository.approvePending(id) !== undefined
    },

    reject(id) {
      return repository.rejectPending(id)
    },

    revoke(id) {
      return repository.revokeAuthorization(id)
    },
  }
}

export function registerManagementRoutes(
  webServer: WebServerRouteHost,
  service: DeviceManagementService,
): () => void {
  return webServer.register({
    kind: 'prefix',
    path: HOST_ADMIN_PREFIX,
    async handler(req, res) {
      if (!sameOrigin(req)) {
        notFound(res)
        return
      }
      let url: URL
      try {
        url = new URL(req.url ?? '/', 'http://token-gate.invalid')
      } catch {
        notFound(res)
        return
      }

      if (req.method === 'GET' && url.pathname === `${HOST_ADMIN_PREFIX}/devices`) {
        json(res, 200, service.list())
        return
      }

      const match = /^\/__token-gate\/(pending|devices)\/([0-9a-f]{64})\/(approve|reject|revoke)$/.exec(url.pathname)
      if (req.method !== 'POST' || match === null) {
        notFound(res)
        return
      }

      const [, collection, id, action] = match
      let changed = false
      if (collection === 'pending' && action === 'approve') changed = await service.approve(id)
      else if (collection === 'pending' && action === 'reject') changed = await service.reject(id)
      else if (collection === 'devices' && action === 'revoke') changed = await service.revoke(id)
      else {
        notFound(res)
        return
      }
      json(res, changed ? 200 : 404, service.list())
    },
  })
}
