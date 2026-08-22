import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import type { Server } from 'node:http'
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { createGateway } from '../src/gateway.ts'
import type { Config } from '../src/config.ts'
import type { Gateway } from '../src/gateway.ts'

const TOKEN = 'test-token-0123456789abcdef'
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
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

function rawRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let raw = ''
    socket.on('connect', () => socket.write(payload))
    socket.on('data', chunk => { raw += chunk.toString() })
    socket.on('end', () => resolve(raw))
    socket.on('error', reject)
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
  await gateway.close()
  await closeServer(upstream)
}

async function bootstrap(port: number, headers: Record<string, string> = {}): Promise<string> {
  const response = await request(port, '/?token=' + TOKEN, { headers })
  assert.equal(response.status, 303)
  const setCookie = response.headers['set-cookie']
  assert.ok(Array.isArray(setCookie))
  return setCookie[0].split(';')[0]
}

test('opaque bootstrap, authority-bound session, browser fence, and sanitized proxying', async (t) => {
  const seen: Array<{ path?: string; headers: Record<string, string | string[] | undefined> }> = []
  const upstream = createServer((req, res) => {
    seen.push({ path: req.url, headers: req.headers })
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      Connection: 'keep-alive, x-upstream-hop',
      'X-Upstream-Hop': 'remove-me',
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
  assert.equal((await request(port, '/?token=wrong')).body, denied.body)
  assert.equal((await request(port, '/?token=' + TOKEN, { headers: { origin: 'https://evil.example.com' } })).status, 404)
  assert.equal(seen.length, 0)

  const ok = await request(port, '/?token=' + TOKEN + '&view=compact', { headers: { 'x-forwarded-for': '203.0.113.11', 'x-forwarded-proto': 'https' } })
  assert.equal(ok.status, 303)
  assert.equal(ok.headers.location, '/?view=compact')
  const setCookie = ok.headers['set-cookie']
  assert.ok(Array.isArray(setCookie))
  assert.match(setCookie[0], /HttpOnly/)
  assert.match(setCookie[0], /Secure/)
  const sessionCookie = setCookie[0].split(';')[0]

  assert.equal((await request(port, '/', { headers: { cookie: sessionCookie, origin: 'https://evil.example.com', 'x-forwarded-proto': 'https' } })).status, 404)
  assert.equal((await request(port, '/', { headers: { cookie: sessionCookie, 'sec-fetch-site': 'cross-site', 'x-forwarded-proto': 'https' } })).status, 404)
  assert.equal((await request(port, '/', { headers: { host: 'other.example.com', cookie: sessionCookie, 'x-forwarded-proto': 'https' } })).status, 404)

  const proxied = await request(port, '/chat?token=app-value', { headers: { cookie: `${sessionCookie}; app_cookie=keep-me`, origin: 'https://dsh.example.com', 'x-forwarded-proto': 'https', connection: 'keep-alive, x-secret-hop', 'x-secret-hop': 'remove-me', 'cf-connecting-ip': '10.1.2.3' } })
  assert.equal(proxied.status, 200)
  assert.equal(proxied.body, 'DSH APP')
  assert.equal(proxied.headers['x-upstream-hop'], undefined)
  assert.deepEqual(proxied.headers['set-cookie'], ['app_session=keep-me; Path=/'])
  assert.equal(seen.length, 1)
  assert.equal(seen[0].path, '/chat?token=app-value')
  assert.equal(seen[0].headers.host, `127.0.0.1:${upstreamPort}`)
  assert.equal(seen[0].headers.origin, `http://127.0.0.1:${upstreamPort}`)
  assert.equal(seen[0].headers['x-secret-hop'], undefined)
  assert.equal(seen[0].headers['x-forwarded-for'], undefined)
  assert.equal(seen[0].headers['cf-connecting-ip'], undefined)
  assert.equal(seen[0].headers.cookie, 'app_cookie=keep-me')
})

test('session cookie is Secure only when the trusted proxy reports HTTPS', async (t) => {
  const upstream = createServer((_req, res) => res.end('ok'))
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = (upstream.address() as AddressInfo).port
  const { gateway, port } = await startGateway(upstreamPort)
  t.after(() => closeFixture(gateway, upstream))

  const local = await request(port, '/?token=' + TOKEN, { headers: { 'x-forwarded-for': '203.0.113.20' } })
  assert.equal(local.status, 303)
  const localCookie = local.headers['set-cookie']
  assert.ok(Array.isArray(localCookie))
  assert.doesNotMatch(localCookie[0], /;\s*Secure\b/i)

  const https = await request(port, '/?token=' + TOKEN, { headers: { 'x-forwarded-for': '203.0.113.21', 'x-forwarded-proto': 'https' } })
  assert.equal(https.status, 303)
  const httpsCookie = https.headers['set-cookie']
  assert.ok(Array.isArray(httpsCookie))
  assert.match(httpsCookie[0], /;\s*Secure\b/i)
})

test('allowlist uses only the configured trusted X-Forwarded-For chain', async (t) => {
  let hits = 0
  const upstream = createServer((_req, res) => { hits += 1; res.end('ok') })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = (upstream.address() as AddressInfo).port
  const { gateway, port } = await startGateway(upstreamPort, baseConfig({ allowIps: ['10.0.0.0/8'], trustedHosts: ['dsh.example.com'] }))
  t.after(() => closeFixture(gateway, upstream))
  assert.equal((await request(port, '/', { headers: { 'cf-connecting-ip': '10.1.2.3', 'x-forwarded-for': '203.0.113.9' } })).status, 404)
  assert.equal((await request(port, '/', { headers: { 'x-forwarded-for': '10.1.2.3' } })).status, 200)
  assert.equal((await request(port, '/', { headers: { host: 'attacker.example.com', 'x-forwarded-for': '10.1.2.3' } })).status, 404)
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
    const timer = setTimeout(() => reject(new Error('downstream response did not terminate after upstream abort')), 1000)
    const settle = (value: 'aborted' | 'ended') => { clearTimeout(timer); resolve(value) }
    const req = httpRequest({ host: '127.0.0.1', port, path: '/', headers: { host: 'dsh.example.com', 'x-forwarded-for': '203.0.113.10', cookie: sessionCookie }, agent: false }, (res) => {
      res.resume()
      res.once('aborted', () => settle('aborted'))
      res.once('error', () => settle('aborted'))
      res.once('end', () => settle('ended'))
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(outcome, 'aborted')
})

test('WebSocket rejects browser-trust violations, sanitizes upgrade headers, relays non-101 responses, preserves early head, and awaits socket close on dispose', async () => {
  const seenUpgrades: Array<Record<string, string | string[] | undefined>> = []
  const upgradedSockets = new Set<Duplex>()
  const upstream = createServer()
  upstream.on('upgrade', (req, socket) => {
    upgradedSockets.add(socket)
    socket.once('close', () => upgradedSockets.delete(socket))
    seenUpgrades.push(req.headers)
    if (req.url === '/reject') { socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Type: text/plain\r\nContent-Length: 7\r\nConnection: close\r\nSet-Cookie: dsh_session=replace-me; Path=/\r\n\r\ndenied!'); return }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSet-Cookie: dsh_session=replace-me; Path=/\r\nSet-Cookie: app_ws=keep-me; Path=/\r\n\r\n')
    socket.on('data', data => socket.write(data))
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = (upstream.address() as AddressInfo).port
  const { gateway, port } = await startGateway(upstreamPort)
  const sessionCookie = await bootstrap(port)

  const deniedUpgrade = await new Promise<boolean>((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/events.mux', headers: { host: 'dsh.example.com', 'x-forwarded-for': '203.0.113.50', cookie: sessionCookie, origin: 'https://evil.example.com', connection: 'Upgrade', upgrade: 'websocket' }, agent: false })
    let upgraded = false
    req.on('upgrade', () => { upgraded = true; resolve(false) })
    req.on('error', () => resolve(!upgraded))
    req.on('close', () => resolve(!upgraded))
    req.end()
  })
  assert.equal(deniedUpgrade, true)

  const rejected = await new Promise<{ status: number | undefined; body: string; setCookie: string[] | undefined }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/reject', headers: { host: 'dsh.example.com', 'x-forwarded-for': '203.0.113.50', cookie: sessionCookie, origin: 'http://dsh.example.com', connection: 'Upgrade', upgrade: 'websocket' }, agent: false })
    req.on('response', (res) => { const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk as Buffer)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), setCookie: res.headers['set-cookie'] })) })
    req.on('error', reject)
    req.end()
  })
  assert.equal(rejected.status, 426)
  assert.equal(rejected.body, 'denied!')
  assert.equal(rejected.setCookie, undefined)

  const earlyEcho = await new Promise<{ raw: string; socket: import('node:net').Socket }>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let raw = ''
    socket.on('connect', () => socket.write(['GET /api/events.mux HTTP/1.1','Host: dsh.example.com','X-Forwarded-For: 203.0.113.50',`Cookie: ${sessionCookie}`,'Origin: http://dsh.example.com','Connection: keep-alive, X-Hop, Upgrade','X-Hop: remove-me','Upgrade: websocket','','EARLY'].join('\r\n')))
    socket.on('data', (chunk) => { raw += chunk.toString(); if (raw.includes('\r\n\r\nEARLY')) resolve({ raw, socket }) })
    socket.on('error', reject)
  })
  assert.match(earlyEcho.raw, /101 Switching Protocols/)
  assert.match(earlyEcho.raw, /\r\n\r\nEARLY/)
  assert.doesNotMatch(earlyEcho.raw, /dsh_session=replace-me/)
  assert.match(earlyEcho.raw, /app_ws=keep-me/)
  const acceptedHeaders = seenUpgrades.at(-1)
  assert.ok(acceptedHeaders)
  assert.equal(acceptedHeaders.connection?.toString().toLowerCase(), 'upgrade')
  assert.equal(acceptedHeaders['x-hop'], undefined)

  const upstreamSocketClosures = [...upgradedSockets].map(socket => new Promise<void>((resolve) => {
    socket.once('close', () => resolve())
  }))
  let clientClosed = false
  earlyEcho.socket.once('close', () => { clientClosed = true })
  await gateway.close()
  await Promise.all(upstreamSocketClosures)
  assert.equal(clientClosed, true)
  assert.equal(earlyEcho.socket.destroyed, true)
  assert.equal(upgradedSockets.size, 0)

  upstream.close()
  upstream.closeAllConnections()
})
