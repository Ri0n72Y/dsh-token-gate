import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { createGateway } from '../src/gateway.ts'
import type { Config } from '../src/config.ts'

const TOKEN = 'test-token-0123456789abcdef'
const logs = { info() {}, warn() {}, error() {} }

function config(): Config {
  return {
    token: TOKEN,
    cookieName: 'dsh_session',
    secureCookie: true,
    sessionTtlDays: 30,
    sessionMax: 32,
    rateMax: 10,
    rateWindowMinutes: 15,
    rateMaxKeys: 32,
    allowIps: [],
    trustedProxies: [],
    trustedHosts: [],
    realIpHeader: 'x-forwarded-for',
    allowGeneratedToken: false,
    bind: '127.0.0.1',
    port: 0,
  }
}

async function startGateway(upstreamPort: number) {
  const gateway = createGateway({
    config: config(),
    token: TOKEN,
    upstream: { host: '127.0.0.1', port: upstreamPort },
    logger: logs,
  })
  await gateway.listen()
  return { gateway, port: (gateway.server.address() as AddressInfo).port }
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

function bootstrap(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/?token=' + TOKEN,
      headers: { host: 'dsh.example.com' },
    }, (res) => {
      const cookies = res.headers['set-cookie']
      if (res.statusCode !== 303 || !Array.isArray(cookies)) {
        reject(new Error(`unexpected bootstrap response: ${String(res.statusCode)}`))
        return
      }
      res.resume()
      res.on('end', () => resolve(cookies[0].split(';')[0]))
    })
    req.on('error', reject)
    req.end()
  })
}

test('unauthenticated parser, Expect, and CONNECT paths are byte-equivalent opaque 404s', async (t) => {
  const upstream = createServer((_req, res) => res.end('unexpected'))
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => upstream.close(() => resolve())))

  const { gateway, port } = await startGateway((upstream.address() as AddressInfo).port)
  t.after(() => gateway.close())

  const ordinary = await rawExchange(port, [
    'GET / HTTP/1.1',
    'Host: dsh.example.com',
    '',
    '',
  ].join('\r\n'))
  assert.match(ordinary, /^HTTP\/1\.1 404 Not Found/)
  assert.doesNotMatch(ordinary, /\r\nDate:/i)

  const parserError = await rawExchange(port, [
    'GET / HTTP/1.1',
    'Host: dsh.example.com',
    'Broken Header',
    '',
    '',
  ].join('\r\n'))
  assert.equal(parserError, ordinary)

  const continueResponse = await rawExchange(port, [
    'POST / HTTP/1.1',
    'Host: dsh.example.com',
    'Expect: 100-continue',
    'Content-Length: 1',
    '',
    '',
  ].join('\r\n'))
  assert.equal(continueResponse, ordinary)
  assert.doesNotMatch(continueResponse, /100 Continue/i)

  const unsupported = await rawExchange(port, [
    'GET / HTTP/1.1',
    'Host: dsh.example.com',
    'Expect: kittens',
    '',
    '',
  ].join('\r\n'))
  assert.equal(unsupported, ordinary)
  assert.doesNotMatch(unsupported, /417 Expectation Failed/i)

  const connectResponse = await rawExchange(port, [
    'CONNECT dsh.example.com:443 HTTP/1.1',
    'Host: dsh.example.com',
    '',
    '',
  ].join('\r\n'))
  assert.equal(connectResponse, ordinary)
})

test('authorized 100-continue is terminated at the gateway and not forwarded upstream', async (t) => {
  let seenExpect: string | undefined
  const upstream = createServer((req, res) => {
    seenExpect = req.headers.expect
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => res.end(Buffer.concat(chunks)))
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => upstream.close(() => resolve())))

  const { gateway, port } = await startGateway((upstream.address() as AddressInfo).port)
  t.after(() => gateway.close())
  const session = await bootstrap(port)

  const result = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/test',
      method: 'POST',
      headers: {
        host: 'dsh.example.com',
        cookie: session,
        expect: '100-continue',
        'content-length': '4',
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk as Buffer))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.once('continue', () => req.end('BODY'))
    req.once('error', reject)
    req.flushHeaders()
  })

  assert.equal(result.status, 200)
  assert.equal(result.body, 'BODY')
  assert.equal(seenExpect, undefined)
})
