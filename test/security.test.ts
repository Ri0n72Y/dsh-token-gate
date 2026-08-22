import test from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { createAuthService } from '../src/auth.ts'
import { createAccessPolicy } from '../src/access.ts'
import { IpSet, normalizeIp } from '../src/net.ts'
import { resolveUpstream } from '../src/upstream.ts'
import { resolveToken } from '../src/config.ts'
import type { Config } from '../src/config.ts'

const baseConfig: Config = {
  token: 'secret',
  cookieName: 'dsh_session',
  sessionTtlDays: 30,
  sessionMax: 16,
  rateMax: 10,
  rateWindowMinutes: 15,
  rateMaxKeys: 16,
  allowIps: [],
  trustedProxies: [],
  trustedHosts: [],
  realIpHeader: 'x-forwarded-for',
  allowGeneratedToken: false,
  bind: '127.0.0.1',
  port: 3081,
}

function fakeReq(remoteAddress: string, host: string, extra: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    url: '/',
    method: 'GET',
    headers: { host },
    socket: { remoteAddress },
    ...extra,
  } as unknown as IncomingMessage
}

test('IpSet handles the address forms used by plugin configuration', () => {
  const set = new IpSet(['10.0.0.0/8', '2001:db8::/32'])
  assert.equal(set.has('10.2.3.4'), true)
  assert.equal(set.has('11.2.3.4'), false)
  assert.equal(set.has('2001:db8::42'), true)
  assert.equal(set.has('2001:db9::42'), false)
  assert.throws(() => new IpSet(['10.0.0.0/99']))
})

test('socket address normalization handles IPv4-mapped loopback', () => {
  assert.equal(normalizeIp('::ffff:127.0.0.1'), '127.0.0.1')
  assert.equal(normalizeIp('[::1]'), '::1')
})

test('DSH upstream must remain loopback-only', () => {
  assert.deepEqual(resolveUpstream({ host: '127.0.0.1', port: 3080 }), { host: '127.0.0.1', port: 3080 })
  assert.throws(() => resolveUpstream({ host: '0.0.0.0', port: 3080 }), /must bind to 127\.0\.0\.1/)
})

test('bootstrap owns only the root token query', () => {
  const auth = createAuthService(baseConfig, 'secret')
  const access = createAccessPolicy(baseConfig, auth)
  const root = fakeReq('203.0.113.10', 'dsh.example.com', { url: '/?x=1&token=secret&y=2' })
  assert.equal(access.decide(root), 'bootstrap')
  assert.equal(access.bootstrapToken(root), 'secret')
  assert.equal(access.cleanBootstrapLocation(root), '/?x=1&y=2')

  const appPath = fakeReq('203.0.113.10', 'dsh.example.com', { url: '/chat?token=app-value' })
  assert.equal(access.bootstrapToken(appPath), undefined)
})

test('trusted X-Forwarded-For parsing follows the configured proxy chain', () => {
  const config = {
    ...baseConfig,
    trustedProxies: ['127.0.0.1/32', '10.0.0.0/8'],
    realIpHeader: 'x-forwarded-for' as const,
  }
  const auth = createAuthService(config, 'secret')
  const access = createAccessPolicy(config, auth)

  const request = fakeReq('127.0.0.1', 'dsh.example.com', {
    headers: { host: 'dsh.example.com', 'x-forwarded-for': '203.0.113.9, 10.1.2.3' },
  })
  assert.equal(access.clientIp(request), '203.0.113.9')
})

test('rate limiter and session store enforce configured bounds', () => {
  const config = { ...baseConfig, rateMaxKeys: 2, rateMax: 10, sessionMax: 1 }
  const auth = createAuthService(config, 'secret')
  assert.equal(auth.authorizeBootstrap('a', 'wrong'), false)
  assert.equal(auth.authorizeBootstrap('b', 'wrong'), false)
  assert.equal(auth.authorizeBootstrap('c', 'secret'), false)

  assert.ok(auth.createSession('a.example'))
  assert.equal(auth.createSession('b.example'), undefined)
})

test('token resolution covers configured, environment, generated, and missing tokens', () => {
  const original = process.env.DSH_AUTH_TOKEN
  try {
    process.env.DSH_AUTH_TOKEN = 'env-secret'
    assert.deepEqual(resolveToken({ ...baseConfig, token: 'config-secret' }), { value: 'config-secret', source: 'config' })
    assert.deepEqual(resolveToken({ ...baseConfig, token: undefined }), { value: 'env-secret', source: 'env' })
    delete process.env.DSH_AUTH_TOKEN
    const generated = resolveToken({ ...baseConfig, token: undefined, allowGeneratedToken: true })
    assert.equal(generated.source, 'generated')
    assert.ok(generated.value.length >= 40)
    assert.throws(() => resolveToken({ ...baseConfig, token: undefined, allowGeneratedToken: false }), /no access token configured/)
  } finally {
    if (original === undefined) delete process.env.DSH_AUTH_TOKEN
    else process.env.DSH_AUTH_TOKEN = original
  }
})
