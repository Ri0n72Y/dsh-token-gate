import test from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { createAuthService } from '../src/auth.ts'
import { createAccessPolicy } from '../src/access.ts'
import { IpSet, isLoopbackHost, isLoopbackIp } from '../src/net.ts'
import type { Config } from '../src/config.ts'

const baseConfig: Config = {
  token: 'secret',
  cookieName: 'dsh_session',
  sessionTtlDays: 30,
  rateMax: 10,
  rateWindowMinutes: 15,
  allowIps: [],
  trustedProxies: ['127.0.0.0/8', '::1/128'],
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

test('loopback helpers accept only loopback addresses and hosts', () => {
  assert.equal(isLoopbackIp('127.0.0.1'), true)
  assert.equal(isLoopbackIp('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackIp('203.0.113.9'), false)
  assert.equal(isLoopbackHost('localhost:3081'), true)
  assert.equal(isLoopbackHost('127.9.8.7:3081'), true)
  assert.equal(isLoopbackHost('example.com'), false)
})

test('IpSet supports IPv4 and IPv6 CIDR and rejects invalid entries', () => {
  const set = new IpSet(['10.0.0.0/8', '2001:db8::/32'])
  assert.equal(set.has('10.2.3.4'), true)
  assert.equal(set.has('11.2.3.4'), false)
  assert.equal(set.has('2001:db8::42'), true)
  assert.equal(set.has('2001:db9::42'), false)
  assert.throws(() => new IpSet(['10.0.0.0/99']))
})

test('remote peer cannot bypass the gate with Host: localhost', () => {
  const auth = createAuthService(baseConfig, 'secret')
  const access = createAccessPolicy(baseConfig, auth)
  const req = fakeReq('203.0.113.10', 'localhost:3081')
  assert.equal(access.decide(req), 'deny')
})

test('direct loopback requires both loopback socket and loopback Host', () => {
  const auth = createAuthService(baseConfig, 'secret')
  const access = createAccessPolicy(baseConfig, auth)
  assert.equal(access.decide(fakeReq('127.0.0.1', 'localhost:3081')), 'allow')
  assert.equal(access.decide(fakeReq('127.0.0.1', 'dsh.example.com')), 'deny')
})

test('forwarded client IP is trusted only from configured proxy peers', () => {
  const config = { ...baseConfig, allowIps: ['10.0.0.0/8'] }
  const auth = createAuthService(config, 'secret')
  const access = createAccessPolicy(config, auth)

  const trusted = fakeReq('127.0.0.1', 'dsh.example.com', {
    headers: { host: 'dsh.example.com', 'x-forwarded-for': '10.1.2.3' },
  })
  assert.equal(access.decide(trusted), 'allow')

  const untrusted = fakeReq('203.0.113.10', 'dsh.example.com', {
    headers: { host: 'dsh.example.com', 'x-forwarded-for': '10.1.2.3' },
  })
  assert.equal(access.decide(untrusted), 'deny')
})

test('bootstrap query is recognized and removed from redirect location', () => {
  const auth = createAuthService(baseConfig, 'secret')
  const access = createAccessPolicy(baseConfig, auth)
  const req = fakeReq('203.0.113.10', 'dsh.example.com', { url: '/chat?x=1&token=secret&y=2' })
  assert.equal(access.decide(req), 'bootstrap')
  assert.equal(access.bootstrapToken(req), 'secret')
  assert.equal(access.cleanBootstrapLocation(req), '/chat?x=1&y=2')
})

test('forwarded HTTPS marker is ignored from untrusted peers', () => {
  const auth = createAuthService(baseConfig, 'secret')
  const access = createAccessPolicy(baseConfig, auth)
  const trusted = fakeReq('127.0.0.1', 'dsh.example.com', {
    headers: { host: 'dsh.example.com', 'x-forwarded-proto': 'https' },
  })
  const untrusted = fakeReq('203.0.113.10', 'dsh.example.com', {
    headers: { host: 'dsh.example.com', 'x-forwarded-proto': 'https' },
  })
  assert.equal(access.isSecure(trusted), true)
  assert.equal(access.isSecure(untrusted), false)
})

test('CF visitor HTTPS signal is accepted only through trusted proxy and malformed metadata is ignored', () => {
  const auth = createAuthService(baseConfig, 'secret')
  const access = createAccessPolicy(baseConfig, auth)
  const secure = fakeReq('127.0.0.1', 'dsh.example.com', {
    headers: { host: 'dsh.example.com', 'cf-visitor': '{"scheme":"https"}' },
  })
  const malformed = fakeReq('127.0.0.1', 'dsh.example.com', {
    headers: { host: 'dsh.example.com', 'cf-visitor': 'not-json' },
  })
  assert.equal(access.isSecure(secure), true)
  assert.equal(access.isSecure(malformed), false)
})
