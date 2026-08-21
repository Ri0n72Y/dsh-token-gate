import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createGateway } from '../src/gateway.ts'
import type { Config } from '../src/config.ts'

const TOKEN = 'test-token-0123456789abcdef'
const logs = { info() {}, warn() {}, error() {} }

function request(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number | undefined; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      headers: {
        host: 'dsh.example.com',
        'cf-connecting-ip': '203.0.113.10',
        ...options.headers,
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk as Buffer))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

test('gateway keeps unauthorized surface opaque and exchanges query token for session', async (t) => {
  const seen: Array<{ path?: string; headers: Record<string, string | string[] | undefined> }> = []
  const upstream = createServer((req, res) => {
    seen.push({ path: req.url, headers: req.headers })
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('DSH APP')
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => upstream.close(() => resolve())))
  const upstreamPort = (upstream.address() as AddressInfo).port

  const config: Config = {
    token: TOKEN,
    cookieName: 'dsh_session',
    sessionTtlDays: 30,
    rateMax: 2,
    rateWindowMinutes: 15,
    allowIps: [],
    trustedProxies: ['127.0.0.0/8'],
    allowGeneratedToken: false,
    bind: '127.0.0.1',
    port: 0,
  }
  const gateway = createGateway({ config, token: TOKEN, upstream: { host: '127.0.0.1', port: upstreamPort }, logger: logs })
  await gateway.listen()
  t.after(() => gateway.close())
  const gatewayPort = (gateway.server.address() as AddressInfo).port

  const denied = await request(gatewayPort, '/')
  assert.equal(denied.status, 404)
  assert.equal(denied.body, '404 page not found\n')

  const probe = await request(gatewayPort, '/api/auth/status')
  assert.equal(probe.status, 404)
  assert.equal(probe.body, denied.body)

  const wrongMethod = await request(gatewayPort, '/?token=' + TOKEN, { method: 'POST' })
  assert.equal(wrongMethod.status, 404)
  assert.equal(wrongMethod.body, denied.body)

  const wrong = await request(gatewayPort, '/?token=wrong')
  assert.equal(wrong.status, 404)
  assert.equal(wrong.body, denied.body)
  assert.equal(seen.length, 0)

  const ok = await request(gatewayPort, '/?token=' + TOKEN + '&view=compact', {
    headers: { 'cf-connecting-ip': '203.0.113.11', 'x-forwarded-proto': 'https' },
  })
  assert.equal(ok.status, 303)
  assert.equal(ok.headers.location, '/?view=compact')
  const setCookie = ok.headers['set-cookie']
  assert.ok(Array.isArray(setCookie))
  assert.match(setCookie[0], /HttpOnly/)
  assert.match(setCookie[0], /SameSite=Lax/)
  assert.match(setCookie[0], /Secure/)
  assert.doesNotMatch(String(ok.headers.location), /token=/)
  assert.equal(seen.length, 0)

  const sessionCookie = setCookie[0].split(';')[0]
  const proxied = await request(gatewayPort, '/', {
    headers: {
      cookie: `${sessionCookie}; app_cookie=keep-me`,
      origin: 'https://dsh.example.com',
      connection: 'keep-alive, x-secret-hop',
      'x-secret-hop': 'remove-me',
    },
  })
  assert.equal(proxied.status, 200)
  assert.equal(proxied.body, 'DSH APP')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].headers.host, `127.0.0.1:${upstreamPort}`)
  assert.equal(seen[0].headers.origin, undefined)
  assert.equal(seen[0].headers['x-secret-hop'], undefined)
  assert.equal(seen[0].headers.cookie, 'app_cookie=keep-me')
  assert.doesNotMatch(String(seen[0].headers.cookie), /dsh_session/)

  const wrongAgain = await request(gatewayPort, '/?token=wrong')
  const limited = await request(gatewayPort, '/?token=wrong-again')
  assert.equal(wrongAgain.status, 404)
  assert.equal(limited.status, 404)
  assert.equal(limited.body, denied.body)
})

test('trusted proxy allowlist works while non-allowlisted client stays hidden', async (t) => {
  let hits = 0
  const upstream = createServer((_req, res) => { hits += 1; res.end('ok') })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => upstream.close(() => resolve())))
  const upstreamPort = (upstream.address() as AddressInfo).port
  const config: Config = {
    token: TOKEN,
    cookieName: 'dsh_session',
    sessionTtlDays: 30,
    rateMax: 10,
    rateWindowMinutes: 15,
    allowIps: ['10.0.0.0/8'],
    trustedProxies: ['127.0.0.0/8'],
    allowGeneratedToken: false,
    bind: '127.0.0.1',
    port: 0,
  }
  const gateway = createGateway({ config, token: TOKEN, upstream: { host: '127.0.0.1', port: upstreamPort }, logger: logs })
  await gateway.listen()
  t.after(() => gateway.close())
  const port = (gateway.server.address() as AddressInfo).port

  const allowed = await request(port, '/', { headers: { 'cf-connecting-ip': '10.1.2.3' } })
  assert.equal(allowed.status, 200)
  const denied = await request(port, '/', { headers: { 'cf-connecting-ip': '172.16.0.2' } })
  assert.equal(denied.status, 404)
  assert.equal(hits, 1)
})

test('WebSocket upgrade is gated, proxied after authentication, and closed on dispose', async () => {
  const upstream = createServer()
  upstream.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', data => socket.write(data))
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = (upstream.address() as AddressInfo).port
  const config: Config = {
    token: TOKEN,
    cookieName: 'dsh_session',
    sessionTtlDays: 30,
    rateMax: 10,
    rateWindowMinutes: 15,
    allowIps: [],
    trustedProxies: ['127.0.0.0/8'],
    allowGeneratedToken: false,
    bind: '127.0.0.1',
    port: 0,
  }
  const gateway = createGateway({ config, token: TOKEN, upstream: { host: '127.0.0.1', port: upstreamPort }, logger: logs })
  await gateway.listen()
  const port = (gateway.server.address() as AddressInfo).port
  await gateway.listen()

  const deniedUpgrade = await new Promise<boolean>((resolve) => {
    const req = httpRequest({
      host: '127.0.0.1', port, path: '/api/events.mux',
      headers: { host: 'dsh.example.com', 'cf-connecting-ip': '203.0.113.50', connection: 'Upgrade', upgrade: 'websocket' },
    })
    let upgraded = false
    req.on('upgrade', () => { upgraded = true; resolve(false) })
    req.on('error', () => resolve(!upgraded))
    req.on('close', () => resolve(!upgraded))
    req.end()
  })
  assert.equal(deniedUpgrade, true)

  const bootstrap = await request(port, '/?token=' + TOKEN, { headers: { 'cf-connecting-ip': '203.0.113.50' } })
  const setCookie = bootstrap.headers['set-cookie']
  assert.ok(Array.isArray(setCookie))
  const sessionCookie = setCookie[0].split(';')[0]

  const socket = await new Promise<import('node:stream').Duplex>((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/events.mux',
      headers: {
        host: 'dsh.example.com',
        'cf-connecting-ip': '203.0.113.50',
        cookie: sessionCookie,
        connection: 'Upgrade',
        upgrade: 'websocket',
      },
    })
    req.on('upgrade', (_res, upgraded) => resolve(upgraded))
    req.on('error', reject)
    req.end()
  })

  const echo = new Promise<string>((resolve, reject) => {
    socket.once('data', data => resolve(data.toString()))
    socket.once('error', reject)
  })
  socket.write('ping')
  assert.equal(await echo, 'ping')

  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
  await gateway.close()
  await closed
  upstream.close()
  upstream.closeAllConnections()
})
