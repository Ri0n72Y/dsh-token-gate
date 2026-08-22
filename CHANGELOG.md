# Changelog

## 0.3.0 - Unreleased

### Security

- Remove implicit loopback bypass and require the DSH upstream web server to remain bound to `127.0.0.1`.
- Default the gateway itself to `127.0.0.1` and make session cookies `Secure` by default.
- Make trusted proxies explicit and resolve `X-Forwarded-For` from the right through the trusted chain; `CF-Connecting-IP` is never used for authorization or rate identity.
- Bind sessions to the authority used during bootstrap and validate Host/Origin/Fetch-Metadata before proxy rewriting, including the bootstrap request itself.
- Reject malformed, absolute-form, scheme-relative, and normalized-to-root request targets before access decisions; keep HTTP parser errors on the same opaque 404 surface where a response is possible.
- Require IP allowlist bypasses to pass a scheme-aware Host fence; named authorities must be declared in `trustedHosts` and explicit ports match the effective external port.
- Keep bootstrap reserved to the literal `/?token=...` namespace.
- Strip gateway cookies, proxy-identity headers, and hop-by-hop headers before forwarding traffic to DSH; prevent upstream `Set-Cookie` from overwriting the gateway session namespace.
- Reconstruct WebSocket `Connection` / `Upgrade` headers instead of forwarding client hop-by-hop declarations.
- Terminate downstream HTTP/WebSocket responses when the upstream aborts after headers instead of leaving partial responses hanging.
- Keep rate-limit identities and active sessions bounded with LRU eviction so cardinality limits cannot become a global authentication lockout.
- Compare bootstrap tokens through fixed-size SHA-256 digests and validate configured cookie names.
- Fail closed when no bootstrap token is configured unless generated-token development mode is explicitly enabled.
- Document that a valid token is an administrator credential and that authenticated loopback rewriting intentionally exposes the DSH control surface to that credential.

### Engineering

- Split the gateway into config, network, access, auth, proxy, upstream, gateway lifecycle, and Cordis entry modules.
- Make Cordis activation/disposal await listen and close, so listen failures fail the fiber and HMR waits for teardown.
- Await owned socket closure during gateway disposal, including upgraded connections.
- Correct WebSocket proxy semantics for non-101 responses and early `head` bytes.
- Replace the monolithic smoke script with Node test-runner unit/integration regressions and coverage gates.
- Add real Cordis `Context` / Fiber lifecycle regression tests in addition to isolated lifecycle fixtures.
- Add raw malformed HTTP and upstream-abort integration regressions.
- Add cross-platform CI and npm package metadata.
- Ship `SECURITY.md` in the npm tarball.
