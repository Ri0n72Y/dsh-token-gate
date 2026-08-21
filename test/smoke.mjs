// Full-chain smoke test for dsh-token-gate:
//   real plugin source (src/index.ts) + a mock upstream pretending to be the
//   dsh webserver + the real gateway server started by the plugin's effect.
// Covers: 404 disguise, /api interception, bootstrap -> HttpOnly cookie,
// session reuse, Host rewrite + Origin strip, IP/CIDR allowlist, loopback
// pass-through, WebSocket upgrade gate, rate limiting, no dsh fingerprint.
import { createServer, request as httpRequest } from 'node:http'
import { apply } from '../src/index.ts'

const TOKEN = 'test-token-0123456789abcdef'
const GATEWAY_PORT = 32081

// ── mock upstream (stands in for the dsh webserver) ────────────────────────
const seen = [] // every forwarded request's { method, path, headers, body }
const upstream = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    seen.push({ method: req.method, path: req.url, headers: req.headers, body })
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html>DSH APP INDEX</html>')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ echo: body }))
  })
})
upstream.on('upgrade', (req, socket) => {
  seen.push({ method: req.method, path: req.url, headers: req.headers, body: '', upgraded: true })
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  socket.on('data', (d) => socket.write(d))
})

// ── plugin boot ────────────────────────────────────────────────────────────
const disposers = []
let upstreamPort = 0

function req(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = httpRequest(
      { host: '127.0.0.1', port: GATEWAY_PORT, path, method, headers: { host: 'dsh.example.com', ...headers } },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }))
      },
    )
    r.on('error', reject)
    if (body !== undefined) r.write(body)
    r.end()
  })
}

function upgrade(path, { headers = {}, payload } = {}) {
  return new Promise((resolve) => {
    const r = httpRequest({
      host: '127.0.0.1',
      port: GATEWAY_PORT,
      path,
      method: 'GET',
      headers: { host: 'dsh.example.com', connection: 'Upgrade', upgrade: 'websocket', ...headers },
    })
    let settled = false
    let gotUpgrade = false
    const done = (result) => { if (!settled) { settled = true; resolve(result) } }
    r.on('upgrade', (res, socket, head) => {
      gotUpgrade = true
      const raw = []
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) raw.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`)
      const lines = [`HTTP/1.1 ${res.statusCode}`, ...raw].join('\n')
      if (payload !== undefined) socket.write(payload)
      socket.on('data', (d) => { done({ status: 101, head: lines, echo: d.toString() }); socket.destroy() })
      socket.on('error', () => {})
    })
    r.on('error', () => done({ status: 'error' }))
    // The request object closes right after a successful upgrade hands the
    // socket over; only treat close as failure when no upgrade arrived.
    r.on('close', () => { if (!gotUpgrade) done({ status: 'closed' }) })
    r.end()
  })
}

const results = []
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  — ${detail}`}`) }

async function main() {
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  upstreamPort = upstream.address().port

  const ctx = {
    get(name) { return name === 'webServer' ? { port: upstreamPort } : undefined },
    effect(fn) { const d = fn(); disposers.push(d ?? (() => {})) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  apply(ctx, {
    token: TOKEN,
    cookieName: 'dsh_session',
    sessionTtlDays: 30,
    rateMax: 10,
    rateWindowMinutes: 15,
    allowIps: ['10.0.0.0/8'],
    bind: '127.0.0.1',
    port: GATEWAY_PORT,
  })

  // 1. unauthenticated remote GET / -> 404 disguise with bootstrap script, no dsh fingerprint
  let r = await req('GET', '/')
  check('unauth GET / -> 404 disguise',
    r.status === 404 && r.body.includes('404 Not Found') && r.body.includes('/api/auth/bootstrap')
    && !r.body.includes('Harness') && !r.body.includes('DSH APP'), `${r.status}`)

  // 2. unauthenticated remote GET /api/... -> 404 (the /api surface is gated too)
  r = await req('GET', '/api/sessions')
  check('unauth /api -> 404', r.status === 404, `${r.status} ${r.body.slice(0, 40)}`)
  check('dsh never saw the denied requests', seen.length === 0, `seen=${seen.length}`)

  // 3. bootstrap with wrong token
  r = await req('POST', '/api/auth/bootstrap', { body: JSON.stringify({ token: 'wrong' }) })
  check('bootstrap wrong token -> 401', r.status === 401, `${r.status}`)

  // 4. bootstrap with correct token -> HttpOnly cookie
  r = await req('POST', '/api/auth/bootstrap', { body: JSON.stringify({ token: TOKEN }) })
  const setCookie = r.headers['set-cookie']
  check('bootstrap ok -> 200 + HttpOnly cookie',
    r.status === 200 && Array.isArray(setCookie) && setCookie[0].includes('HttpOnly')
    && setCookie[0].includes('SameSite=Lax') && setCookie[0].includes('dsh_session='), `${r.status} ${setCookie}`)
  const sid = Array.isArray(setCookie) ? setCookie[0].split('=')[1].split(';')[0] : ''

  // 5. session reuse: cookie -> proxied to upstream, Host rewritten, Origin stripped
  const withCookie = { cookie: `dsh_session=${sid}`, origin: 'https://dsh.example.com' }
  r = await req('GET', '/', { headers: withCookie })
  check('authenticated GET / -> proxied 200', r.status === 200 && r.body === '<html>DSH APP INDEX</html>', `${r.status} ${r.body.slice(0, 40)}`)
  const seenRoot = seen.find((s) => s.path === '/')
  check('upstream saw loopback Host', seenRoot !== undefined && seenRoot.headers.host === `127.0.0.1:${upstreamPort}`, seenRoot?.headers.host)
  check('upstream did not see Origin', seenRoot !== undefined && seenRoot.headers.origin === undefined, String(seenRoot?.headers.origin))

  // 6. POST body forwarded
  r = await req('POST', '/api/echo', { headers: withCookie, body: 'hello-body' })
  check('POST body forwarded', r.status === 200 && r.body.includes('hello-body'), `${r.status} ${r.body.slice(0, 40)}`)

  // 7. loopback Host pass-through without cookie
  r = await req('GET', '/', { headers: { host: `127.0.0.1:${GATEWAY_PORT}` } })
  check('loopback Host -> allow', r.status === 200, `${r.status}`)

  // 8. allowlist via CF-Connecting-IP (trusted-proxy branch: socket loopback, Host remote)
  r = await req('GET', '/', { headers: { 'cf-connecting-ip': '10.1.2.3' } })
  check('allowlist CIDR 10.0.0.0/8 -> allow', r.status === 200, `${r.status}`)
  r = await req('GET', '/', { headers: { 'cf-connecting-ip': '172.16.0.9' } })
  check('non-allowlisted IP -> 404', r.status === 404, `${r.status}`)

  // 9. WebSocket: unauthenticated upgrade is killed
  let ws = await upgrade('/api/events.mux')
  check('unauth upgrade -> no 101', ws.status !== 101, JSON.stringify(ws))

  // 10. WebSocket: authenticated upgrade is proxied and echoes
  ws = await upgrade('/api/events.mux', { headers: withCookie, payload: 'ping' })
  check('auth upgrade -> 101 + echo', ws.status === 101 && ws.echo === 'ping', JSON.stringify(ws))

  // 11. rate limiting: 12 rapid wrong tokens -> 429
  let got429 = false
  for (let i = 0; i < 12; i += 1) {
    const attempt = await req('POST', '/api/auth/bootstrap', { body: JSON.stringify({ token: 'brute' }) })
    if (attempt.status === 429) { got429 = true; break }
  }
  check('rate limit engages', got429 === true)

  // 12. logout revokes
  r = await req('POST', '/api/auth/logout', { headers: withCookie })
  check('logout ok', r.status === 200, `${r.status}`)
  r = await req('GET', '/', { headers: withCookie })
  check('session revoked after logout -> 404', r.status === 404, `${r.status}`)

  for (const dispose of disposers.reverse()) await dispose()
  upstream.closeAllConnections()
  try { upstream.close() } catch { /* already closed */ }
  const failed = results.filter((x) => !x.ok).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => { console.error(error); process.exit(1) })
