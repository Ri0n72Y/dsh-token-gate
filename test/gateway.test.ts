import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { createGateway } from '../src/gateway.ts'
import type { Config } from '../src/config.ts'

const TOKEN = 'test-token-0123456789abcdef'
const logs = { info() {}, warn() {}, error() {} }

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    token: TOKEN, cookieName: 'dsh_session', secureCookie: true, sessionTtlDays: 30, sessionMax: 64,
    rateMax: 4, rateWindowMinutes: 15, rateMaxKeys: 64, allowIps: [],
    trustedProxies: ['127.0.0.1/32'], trustedHosts: [], realIpHeader: 'x-forwarded-for',
    allowGeneratedToken: false, bind: '127.0.0.1', port: 0, ...overrides,
  }
}

function request(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number | undefined; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host: 'dsh.example.com', 'x-forwarded-for': '203.0.113.10', ...options.headers } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk as Buffer))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

async function startGateway(upstreamPort: number, config: Config = baseConfig()) {
  const gateway = createGateway({ config, token: TOKEN, upstream: { host: '127.0.0.1', port: upstreamPort }, logger: logs })
  await gateway.listen()
  return { gateway, port: (gateway.server.address() as AddressInfo).port }
}

async function bootstrap(port: number, headers: Record<string, string> = {}): Promise<string> {
  const response = await request(port, '/?token=' + TOKEN, { headers })
  assert.equal(response.status, 303)
  const setCookie = response.headers['set-cookie']
  assert.ok(Array.isArray(setCookie))
  return setCookie[0].split(';')[0]
}

function rawExchange(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let raw = ''
    socket.on('connect', () => socket.write(payload))
    socket.on('data', chunk => { raw += chunk.toString() })
    socket.on('end', () => resolve(raw))
    socket.on('close', () => resolve(raw))
    socket.on('error', reject)
  })
}

test('opaque bootstrap, authority-bound session, browser fence, and sanitized proxying', async (t) => {
  const seen: Array<{ path?: string; headers: Record<string, string | string[] | undefined> }> = []
  const upstream = createServer((req, res) => {
    seen.push({ path: req.url, headers: req.headers })
    res.writeHead(200, { 'Content-Type': 'text/plain', Connection: 'keep-alive, x-upstream-hop', 'X-Upstream-Hop': 'remove-me' })
    res.end('DSH APP')
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => upstream.close(() => resolve())))
  const upstreamPort = (upstream.address() as AddressInfo).port
  const { gateway, port } = await startGateway(upstreamPort)
  t.after(() => gateway.close())

  const denied = await request(port, '/')
  assert.equal(denied.status, 404)
  assert.equal(denied.body, '404 page not found\n')
  assert.equal((await request(port, '/chat?token=' + TOKEN)).status, 404)
  assert.equal((await request(port, '/?token=wrong')).body, denied.body)
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
  assert.equal(seen.length, 1)
  assert.equal(seen[0].path, '/chat?token=app-value')
  assert.equal(seen[0].headers.host, `127.0.0.1:${upstreamPort}`)
  assert.equal(seen[0].headers.origin, `http://127.0.0.1:${upstreamPort}`)
  assert.equal(seen[0].headers['x-secret-hop'], undefined)
  assert.equal(seen[0].headers['x-forwarded-for'], undefined)
  assert.equal(seen[0].headers['cf-connecting-ip'], undefined)
  assert.equal(seen[0].headers.cookie, 'app_cookie=keep-me')
})

test('allowlist cannot be bypassed with CF header behind a generic local proxy', async (t) => {
  let hits = 0
  const upstream = createServer((_req, res) => { hits += 1; res.end('ok') })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => upstream.close(() => resolve())))
  const upstreamPort = (upstream.address() as AddressInfo).port
  const { gateway, port } = await startGateway(upstreamPort, baseConfig({ allowIps: ['10.0.0.0/8'], trustedHosts: ['dsh.example.com'] }))
  t.after(() => gateway.close())
  assert.equal((await request(port, '/', { headers: { 'cf-connecting-ip': '10.1.2.3', 'x-forwarded-for': '203.0.113.9' } })).status, 404)
  assert.equal((await request(port, '/', { headers: { 'x-forwarded-for': '10.1.2.3' } })).status, 200)
  assert.equal((await request(port, '/', { headers: { host: 'attacker.example.com', 'x-forwarded-for': '10.1.2.3' } })).status, 404)
  assert.equal(hits, 1)
})

test('malformed request targets and parser errors stay on the opaque 404 surface', async (t) => {
  const upstream = createServer((_req, res) => res.end('unexpected'))
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => upstream.close(() => resolve())))
  const { gateway, port } = await startGateway((upstream.address() as AddressInfo).port)
  t.after(() => gateway.close())

  const malformedTarget = await rawExchange(port, 'GET //[bad HTTP/1.1\r\nHost: dsh.example.com\r\n\r\n')
  assert.match(malformedTarget, /^HTTP\/1\.1 404/)
  assert.match(malformedTarget, /404 page not found/)

  const parserError = await rawExchange(port, 'GET / HTTP/1.1\r\nHost: dsh.example.com\r\nBroken Header\r\n\r\n')
  assert.match(parserError, /^HTTP\/1\.1 404/)
  assert.match(parserError, /404 page not found/)
})

test('upstream body abort terminates the downstream response', async (t) => {
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Length': '100' })
    res.flushHeaders()
    res.write('partial')
    setTimeout(() => res.socket?.destroy(), 20)
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => upstream.close(() => resolve())))
  const { gateway, port } = await startGateway((upstream.address() as AddressInfo).port)
  t.after(() => gateway.close())
  const sessionCookie = await bootstrap(port)

  const outcome = await new Promise<'aborted' | 'incomplete-end' | 'complete'>((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port, path: '/',
      headers: { host: 'dsh.example.com', 'x-forwarded-for': '203.0.113.10', cookie: sessionCookie },
    }, (res) => {
      res.resume()
      res.once('aborted', () => resolve('aborted'))
      res.once('end', () => resolve(res.complete ? 'complete' : 'incomplete-end'))
      res.once('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
  assert.notEqual(outcome, 'complete')
})

test('WebSocket rejects browser-trust violations, relays non-101 responses, preserves early head, and closes on dispose', async () => {
  const upstream = createServer()
  upstream.on('upgrade', (req, socket) => {
    if (req.url === '/reject') { socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Type: text/plain\r\nContent-Length: 7\r\nConnection: close\r\n\r\ndenied!'); return }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', data => socket.write(data))
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = (upstream.address() as AddressInfo).port
  const { gateway, port } = await startGateway(upstreamPort)
  const sessionCookie = await bootstrap(port)

  const deniedUpgrade = await new Promise<boolean>((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/events.mux', headers: { host: 'dsh.example.com', 'x-forwarded-for': '203.0.113.50', cookie: sessionCookie, origin: 'http://evil.example.com', connection: 'Upgrade', upgrade: 'websocket' } })
    let upgraded = false
    req.on('upgrade', () => { upgraded = true; resolve(false) })
    req.on('error', () => resolve(!upgraded))
    req.on('close', () => resolve(!upgraded))
    req.end()
  })
  assert.equal(deniedUpgrade, true)

  const rejected = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/reject', headers: { host: 'dsh.example.com', 'x-forwarded-for': '203.0.113.50', cookie: sessionCookie, origin: 'http://dsh.example.com', connection: 'Upgrade', upgrade: 'websocket' } })
    req.on('response', (res) => { const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk as Buffer)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })) })
    req.on('error', reject)
    req.end()
  })
  assert.equal(rejected.status, 426)
  assert.equal(rejected.body, 'denied!')

  const earlyEcho = await new Promise<{ raw: string; socket: import('node:net').Socket }>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let raw = ''
    socket.on('connect', () => socket.write(['GET /api/events.mux HTTP/1.1','Host: dsh.example.com','X-Forwarded-For: 203.0.113.50',`Cookie: ${sessionCookie}`,'Origin: http://dsh.example.com','Connection: keep-alive, Upgrade, x-hop','X-Hop: remove-me','Upgrade: websocket','','EARLY'].join('\r\n')))
    socket.on('data', (chunk) => { raw += chunk.toString(); if (raw.includes('\r\n\r\nEARLY')) resolve({ raw, socket }) })
    socket.on('error', reject)
  })
  assert.match(earlyEcho.raw, /101 Switching Protocols/)
  assert.match(earlyEcho.raw, /Connection: Upgrade/i)
  assert.doesNotMatch(earlyEcho.raw, /x-hop/i)
  assert.match(earlyEcho.raw, /\r\n\r\nEARLY/)
  const closed = new Promise<void>(resolve => earlyEcho.socket.once('close', () => resolve()))
  await gateway.close()
  await closed
  upstream.close()
  upstream.closeAllConnections()
})
