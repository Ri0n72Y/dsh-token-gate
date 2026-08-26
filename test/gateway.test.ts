import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import type { Server } from 'node:http'
import { connect } from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import { createAuthService } from '../src/auth.ts'
import type { Config } from '../src/config.ts'
import { createGateway } from '../src/gateway.ts'
import type { Gateway } from '../src/gateway.ts'
import { createDeviceManagementService } from '../src/management.ts'
import { createDeviceSessionService } from '../src/session.ts'
import { authorizationState, MemoryAuthorizationRepository } from './helpers.ts'

const TOKEN = 'test-token-0123456789abcdef'
const IO_TIMEOUT_MS = 2000
const logs = { info() {}, warn() {}, error() {} }

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    token: TOKEN,
    cookieName: 'dsh_session',
    pairingCookieName: 'dsh_pairing',
    sessionTtlDays: 30,
    renewalIntervalHours: 24,
    pendingTtlMinutes: 15,
    trustedProxies: ['127.0.0.1/32'],
    allowGeneratedToken: false,
    bind: '127.0.0.1',
    port: 0,
    ...overrides,
  }
}

function request(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number | undefined; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      headers: { host: 'dsh.example.com', ...options.headers },
      agent: false,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk as Buffer))
      res.on('aborted', () => reject(new Error(`HTTP response aborted for ${path}`)))
      res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.setTimeout(IO_TIMEOUT_MS, () => req.destroy(new Error(`HTTP request timed out for ${path}`)))
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

function rawRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let raw = ''
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      socket.setTimeout(0)
      reject(error)
    }
    const finish = () => {
      if (settled) return
      settled = true
      socket.setTimeout(0)
      resolve(raw)
    }
    socket.setTimeout(IO_TIMEOUT_MS, () => socket.destroy(new Error('raw HTTP request timed out')))
    socket.on('connect', () => socket.write(payload))
    socket.on('data', chunk => { raw += chunk.toString() })
    socket.on('end', finish)
    socket.on('error', fail)
    socket.on('close', () => {
      if (!settled) fail(new Error('raw HTTP connection closed before response completed'))
    })
  })
}

function withinTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), IO_TIMEOUT_MS)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function startGateway(
  upstreamPort: number,
  repository = new MemoryAuthorizationRepository(),
  config: Config = baseConfig(),
  now?: () => number,
) {
  const gateway = createGateway({
    config,
    token: TOKEN,
    upstream: { host: '127.0.0.1', port: upstreamPort },
    repository,
    logger: logs,
    now,
  })
  await gateway.listen()
  return { gateway, repository, port: (gateway.server.address() as AddressInfo).port }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

async function closeFixture(gateway: Gateway, upstream: Server): Promise<void> {
  await closeServer(gateway.server)
  await closeServer(upstream)
}

function cookieFrom(headers: Record<string, string | string[] | undefined>, name: string): string {
  const values = headers['set-cookie']
  assert.ok(Array.isArray(values))
  const found = values.find(value => value.startsWith(`${name}=`))
  assert.ok(found)
  return found.split(';')[0]
}

async function pair(port: number, headers: Record<string, string> = {}): Promise<string> {
  const response = await request(port, `/?token=${TOKEN}`, { headers })
  assert.equal(response.status, 303)
  assert.match(String(response.headers.location), /^\/_token-gate\/wait\?returnTo=/)
  return cookieFrom(response.headers, 'dsh_pairing')
}

async function authorize(port: number, repository: MemoryAuthorizationRepository): Promise<string> {
  const pairingCookie = await pair(port)
  const pending = repository.listPending()
  assert.equal(pending.length, 1)
  assert.ok(await repository.approvePending(pending[0].id))
  const status = await request(port, '/_token-gate/status', { headers: { cookie: pairingCookie } })
  assert.equal(status.status, 200)
  assert.deepEqual(JSON.parse(status.body), { state: 'approved' })
  return cookieFrom(status.headers, 'dsh_session')
}

test('token pairing stays pending until host approval, then proxies with isolated cookies', async (t) => {
  const seen: Array<{ path?: string; cookie?: string }> = []
  const upstream = createServer((req, res) => {
    seen.push({ path: req.url, cookie: req.headers.cookie })
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Set-Cookie': [
        'dsh_session=replace-me; Path=/',
        'dsh_pairing=replace-me-too; Path=/',
        'app_session=keep-me; Path=/',
      ],
    })
    res.end('DSH APP')
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = (upstream.address() as AddressInfo).port
  const { gateway, repository, port } = await startGateway(upstreamPort)
  t.after(() => closeFixture(gateway, upstream))

  const malformed = await rawRequest(port, 'GET //[bad HTTP/1.1\r\nHost: dsh.example.com\r\nConnection: close\r\n\r\n')
  assert.match(malformed, /^HTTP\/1\.1 404 /)
  assert.equal((await request(port, '/')).status, 404)
  assert.equal((await request(port, `/chat?token=${TOKEN}`)).status, 404)
  assert.equal((await request(port, '/__token-gate/devices')).status, 404)

  const login = await request(port, `/?token=${TOKEN}&view=compact`, {
    headers: { 'x-forwarded-proto': 'https', 'user-agent': 'Test Browser' },
  })
  assert.equal(login.status, 303)
  assert.equal(login.headers.location, '/_token-gate/wait?returnTo=%2F%3Fview%3Dcompact')
  const pairingCookie = cookieFrom(login.headers, 'dsh_pairing')
  const pairingSetCookie = (login.headers['set-cookie'] as string[])[0]
  assert.match(pairingSetCookie, /HttpOnly/)
  assert.match(pairingSetCookie, /;\s*Secure\b/i)
  assert.equal(repository.listPending().length, 1)
  assert.equal(seen.length, 0)

  assert.equal((await request(port, '/_token-gate/wait?returnTo=%2F', { headers: { cookie: pairingCookie } })).status, 200)
  const waiting = await request(port, '/_token-gate/status', { headers: { cookie: pairingCookie } })
  assert.equal(waiting.status, 202)
  assert.deepEqual(JSON.parse(waiting.body), { state: 'pending' })
  assert.equal(seen.length, 0)

  const pending = repository.listPending()[0]
  assert.ok(await repository.approvePending(pending.id))
  const approved = await request(port, '/_token-gate/status', { headers: { cookie: pairingCookie } })
  assert.equal(approved.status, 200)
  const sessionCookie = cookieFrom(approved.headers, 'dsh_session')
  assert.equal(repository.listDevices().length, 1)

  const proxied = await request(port, '/chat?token=app-value', {
    headers: { cookie: `${sessionCookie}; ${pairingCookie}; app_cookie=keep-me` },
  })
  assert.equal(proxied.status, 200)
  assert.equal(proxied.body, 'DSH APP')
  assert.deepEqual(proxied.headers['set-cookie'], ['app_session=keep-me; Path=/'])
  assert.deepEqual(seen, [{ path: '/chat?token=app-value', cookie: 'app_cookie=keep-me' }])
})

test('authorized device survives gateway recreation, revocation invalidates it, and pairing can start again', async (t) => {
  const upstream = createServer((_req, res) => res.end('ok'))
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = (upstream.address() as AddressInfo).port
  const state = authorizationState()
  const firstRepository = new MemoryAuthorizationRepository(state)
  const first = await startGateway(upstreamPort, firstRepository)
  const sessionCookie = await authorize(first.port, firstRepository)
  assert.equal((await request(first.port, '/', { headers: { cookie: sessionCookie } })).status, 200)
  await first.gateway.close()

  const reopenedRepository = new MemoryAuthorizationRepository(state)
  const reopened = await startGateway(upstreamPort, reopenedRepository)
  t.after(() => closeFixture(reopened.gateway, upstream))
  assert.equal((await request(reopened.port, '/', { headers: { cookie: sessionCookie } })).status, 200)

  const device = reopenedRepository.listDevices()[0]
  const management = createDeviceManagementService(reopenedRepository)
  assert.equal(await management.revoke(device.id), true)
  assert.equal((await request(reopened.port, '/', { headers: { cookie: sessionCookie } })).status, 404)

  const newPairing = await pair(reopened.port)
  assert.match(newPairing, /^dsh_pairing=/)
  assert.equal(reopenedRepository.listPending().length, 1)
})

test('sliding expiry renews durably only after the configured threshold', async () => {
  const config = baseConfig()
  const repository = new MemoryAuthorizationRepository()
  const auth = createAuthService(config, TOKEN)
  let clock = 1_000_000
  const session = createDeviceSessionService(config, auth, repository, () => clock)
  const pairingBearer = 'pairing-bearer-for-renewal'
  const pairingId = auth.digestBearer(pairingBearer)
  await repository.putPending(pairingId, {
    authority: 'dsh.example.com',
    browser: 'Test Browser',
    requestedAt: clock,
    expiresAt: clock + 60 * 60 * 1000,
    state: 'approved',
    approvedAt: clock,
  })
  const pending = repository.getPending(pairingId)
  assert.ok(pending)
  const issued = await session.issueApprovedSession(pairingBearer, pairingId, pending, false)
  const original = repository.getDevice(issued.deviceId)
  assert.ok(original)

  clock += 12 * 60 * 60 * 1000
  assert.equal((await session.validate(issued.bearer, 'dsh.example.com', false)).allowed, true)
  assert.equal(repository.renewWrites, 0)

  clock += 12 * 60 * 60 * 1000
  const renewed = await session.validate(issued.bearer, 'dsh.example.com', false)
  assert.equal(renewed.allowed, true)
  assert.ok(renewed.allowed && renewed.refreshCookie?.startsWith('dsh_session='))
  assert.equal(repository.renewWrites, 1)
  assert.ok((repository.getDevice(issued.deviceId)?.expiresAt ?? 0) > original.expiresAt)

  await session.validate(issued.bearer, 'dsh.example.com', false)
  assert.equal(repository.renewWrites, 1)
})

test('upstream body abort terminates the downstream response', async (t) => {
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Length': '100' })
    res.write('partial')
    setImmediate(() => res.destroy())
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = (upstream.address() as AddressInfo).port
  const { gateway, repository, port } = await startGateway(upstreamPort)
  t.after(() => closeFixture(gateway, upstream))
  const sessionCookie = await authorize(port, repository)

  const outcome = await new Promise<'aborted' | 'ended'>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('downstream response did not terminate after upstream abort')), IO_TIMEOUT_MS)
    const settle = (value: 'aborted' | 'ended') => { clearTimeout(timer); resolve(value) }
    const fail = (error: Error) => { clearTimeout(timer); reject(error) }
    const req = httpRequest({ host: '127.0.0.1', port, path: '/', headers: { host: 'dsh.example.com', cookie: sessionCookie }, agent: false }, (res) => {
      res.resume()
      res.once('aborted', () => settle('aborted'))
      res.once('error', () => settle('aborted'))
      res.once('end', () => settle('ended'))
    })
    req.on('error', fail)
    req.end()
  })
  assert.equal(outcome, 'aborted')
})

test('WebSocket relays rejection and early data, and gateway disposal closes the client', async (t) => {
  const upstreamSockets = new Set<import('node:stream').Duplex>()
  const upstream = createServer()
  let upgradedClient: Socket | undefined
  upstream.on('upgrade', (req, socket) => {
    upstreamSockets.add(socket)
    socket.once('close', () => upstreamSockets.delete(socket))
    if (req.url === '/reject') {
      socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Type: text/plain\r\nContent-Length: 7\r\nConnection: close\r\n\r\ndenied!')
      return
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', data => socket.write(data))
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = (upstream.address() as AddressInfo).port
  const { gateway, repository, port } = await startGateway(upstreamPort)
  t.after(async () => {
    upgradedClient?.destroy()
    for (const socket of upstreamSockets) socket.destroy()
    await closeServer(gateway.server)
    await closeServer(upstream)
  })
  const sessionCookie = await authorize(port, repository)

  const rejected = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/reject', headers: { host: 'dsh.example.com', cookie: sessionCookie, origin: 'http://dsh.example.com', connection: 'Upgrade', upgrade: 'websocket' }, agent: false })
    req.setTimeout(IO_TIMEOUT_MS, () => req.destroy(new Error('WebSocket rejection request timed out')))
    req.on('response', (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk as Buffer))
      res.on('aborted', () => reject(new Error('WebSocket rejection response aborted')))
      res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('upgrade', (_res, socket) => {
      socket.destroy()
      reject(new Error('expected ordinary HTTP rejection, received an upgrade'))
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(rejected.status, 426)
  assert.equal(rejected.body, 'denied!')

  const earlyEcho = await new Promise<{ raw: string; socket: Socket }>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    upgradedClient = socket
    let raw = ''
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      socket.setTimeout(0)
      reject(error)
    }
    socket.setTimeout(IO_TIMEOUT_MS, () => socket.destroy(new Error('WebSocket handshake timed out')))
    socket.on('connect', () => socket.write([
      'GET /api/events.mux HTTP/1.1',
      'Host: dsh.example.com',
      `Cookie: ${sessionCookie}`,
      'Origin: http://dsh.example.com',
      'Connection: Upgrade',
      'Upgrade: websocket',
      '',
      'EARLY',
    ].join('\r\n')))
    socket.on('data', (chunk) => {
      raw += chunk.toString()
      if (!settled && raw.includes('\r\n\r\nEARLY')) {
        settled = true
        socket.setTimeout(0)
        resolve({ raw, socket })
      }
    })
    socket.on('error', fail)
    socket.on('close', () => {
      if (!settled) fail(new Error('WebSocket connection closed before early data was echoed'))
    })
  })
  assert.match(earlyEcho.raw, /^HTTP\/1\.1 101 /)
  assert.match(earlyEcho.raw, /\r\n\r\nEARLY/)

  let clientClosed = false
  earlyEcho.socket.once('close', () => { clientClosed = true })
  await withinTimeout(gateway.close(), 'gateway.close() did not settle after destroying the active WebSocket')
  assert.equal(clientClosed, true)
})
