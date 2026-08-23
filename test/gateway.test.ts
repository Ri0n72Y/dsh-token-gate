import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import type { Server } from 'node:http'
import { connect } from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import { createGateway } from '../src/gateway.ts'
import type { Config } from '../src/config.ts'
import type { Gateway } from '../src/gateway.ts'

const TOKEN = 'test-token-0123456789abcdef'
const IO_TIMEOUT_MS = 2000
const logs = { info() {}, warn() {}, error() {} }

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    token: TOKEN, cookieName: 'dsh_session', sessionTtlDays: 30, sessionMax: 64,
    rateMax: 4, rateWindowMinutes: 15, rateMaxKeys: 64, allowIps: [],
    trustedProxies: ['127.0.0.1/32'], trustedHosts: [], realIpHeader: 'x-forwarded-for',
    allowGeneratedToken: false, bind: '127.0.0.1', port: 0, ...overrides,
  }
}

function request(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number | undefined; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      headers: { host: 'dsh.example.com', 'x-forwarded-for': '203.0.113.10', ...options.headers },
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

async function startGateway(upstreamPort: number, config: Config = baseConfig()) {
  const gateway = createGateway({ config, token: TOKEN, upstream: { host: '127.0.0.1', port: upstreamPort }, logger: logs })
  await gateway.listen()
  return { gateway, port: (gateway.server.address() as AddressInfo).port }
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

async function bootstrap(port: number, headers: Record<string, string> = {}): Promise<string> {
  const response = await request(port, '/?token=' + TOKEN, { headers })
  assert.equal(response.status, 303)
  const setCookie = response.headers['set-cookie']
  assert.ok(Array.isArray(setCookie))
  return setCookie[0].split(';')[0]
}

test('bootstrap creates a session and authorized HTTP requests reach DSH', async (t) => {
  const seen: Array<{ path?: string; cookie?: string }> = []
  const upstream = createServer((req, res) => {
    seen.push({ path: req.url, cookie: req.headers.cookie })
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Set-Cookie': ['dsh_session=replace-me; Path=/', 'app_session=keep-me; Path=/'],
    })
    res.end('DSH APP')
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = (upstream.address() as AddressInfo).port
  const { gateway, port } = await startGateway(upstreamPort)
  t.after(() => closeFixture(gateway, upstream))

  const malformed = await rawRequest(port, 'GET //[bad HTTP/1.1\r\nHost: dsh.example.com\r\nConnection: close\r\n\r\n')
  assert.match(malformed, /^HTTP\/1\.1 404 /)

  const denied = await request(port, '/')
  assert.equal(denied.status, 404)
  assert.equal(denied.body, '404 page not found\n')
  assert.equal((await request(port, '/chat?token=' + TOKEN)).status, 404)

  const login = await request(port, '/?token=' + TOKEN + '&view=compact', { headers: { 'x-forwarded-proto': 'https' } })
  assert.equal(login.status, 303)
  assert.equal(login.headers.location, '/?view=compact')
  const setCookie = login.headers['set-cookie']
  assert.ok(Array.isArray(setCookie))
  assert.match(setCookie[0], /HttpOnly/)
  const sessionCookie = setCookie[0].split(';')[0]

  const proxied = await request(port, '/chat?token=app-value', { headers: { cookie: `${sessionCookie}; app_cookie=keep-me` } })
  assert.equal(proxied.status, 200)
  assert.equal(proxied.body, 'DSH APP')
  assert.deepEqual(proxied.headers['set-cookie'], ['app_session=keep-me; Path=/'])
  assert.deepEqual(seen, [{ path: '/chat?token=app-value', cookie: 'app_cookie=keep-me' }])
})

test('session cookie uses Secure only for HTTPS ingress', async (t) => {
  const upstream = createServer((_req, res) => res.end('ok'))
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = (upstream.address() as AddressInfo).port
  const { gateway, port } = await startGateway(upstreamPort)
  t.after(() => closeFixture(gateway, upstream))

  const local = await request(port, '/?token=' + TOKEN)
  assert.equal(local.status, 303)
  const localCookie = local.headers['set-cookie']
  assert.ok(Array.isArray(localCookie))
  assert.doesNotMatch(localCookie[0], /;\s*Secure\b/i)

  const https = await request(port, '/?token=' + TOKEN, { headers: { 'x-forwarded-proto': 'https' } })
  assert.equal(https.status, 303)
  const httpsCookie = https.headers['set-cookie']
  assert.ok(Array.isArray(httpsCookie))
  assert.match(httpsCookie[0], /;\s*Secure\b/i)
})

test('configured IP allowlist can bypass the session', async (t) => {
  let hits = 0
  const upstream = createServer((_req, res) => { hits += 1; res.end('ok') })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = (upstream.address() as AddressInfo).port
  const { gateway, port } = await startGateway(upstreamPort, baseConfig({ allowIps: ['203.0.113.0/24'] }))
  t.after(() => closeFixture(gateway, upstream))

  assert.equal((await request(port, '/', { headers: { host: '192.0.2.10:3081', 'x-forwarded-for': '203.0.113.9' } })).status, 200)
  assert.equal((await request(port, '/', { headers: { host: '192.0.2.10:3081', 'x-forwarded-for': '198.51.100.9' } })).status, 404)
  assert.equal(hits, 1)
})

test('upstream body abort terminates the downstream response', async (t) => {
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Length': '100' })
    res.write('partial')
    setImmediate(() => res.destroy())
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = (upstream.address() as AddressInfo).port
  const { gateway, port } = await startGateway(upstreamPort)
  t.after(() => closeFixture(gateway, upstream))
  const sessionCookie = await bootstrap(port)

  const outcome = await new Promise<'aborted' | 'ended'>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('downstream response did not terminate after upstream abort')), IO_TIMEOUT_MS)
    const settle = (value: 'aborted' | 'ended') => { clearTimeout(timer); resolve(value) }
    const fail = (error: Error) => { clearTimeout(timer); reject(error) }
    const req = httpRequest({ host: '127.0.0.1', port, path: '/', headers: { host: 'dsh.example.com', 'x-forwarded-for': '203.0.113.10', cookie: sessionCookie }, agent: false }, (res) => {
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

test('WebSocket relays rejection, early data, and closes the client on gateway dispose', async (t) => {
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
  const { gateway, port } = await startGateway(upstreamPort)
  t.after(async () => {
    upgradedClient?.destroy()
    for (const socket of upstreamSockets) socket.destroy()
    await closeServer(gateway.server)
    await closeServer(upstream)
  })
  const sessionCookie = await bootstrap(port)

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
