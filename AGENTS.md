# AGENTS.md

## Scope

This repository is a security boundary in front of DeepSeek Harness. Prefer small, explicit modules and fail-closed behavior.

## Invariants

- DSH upstream must remain bound to `127.0.0.1`; public traffic must reach the gateway, never the DSH port directly.
- The gateway itself defaults to `127.0.0.1`; widening the bind address is an explicit deployment choice.
- There is no implicit loopback bypass; any IP bypass must be explicit in `allowIps`.
- `Host` never grants access by itself: sessions are authority-bound, and IP bypasses must pass the browser/Host fence.
- Forwarded client/protocol headers are ignored unless the socket peer is explicitly listed in `trustedProxies`.
- `X-Forwarded-For` is resolved right-to-left through the trusted-proxy chain; `CF-Connecting-IP` never participates in authorization or rate identity.
- Browser `Origin` and Fetch Metadata are validated before internal Host/Origin rewriting, including bootstrap.
- Ordinary authenticated requests reject explicit cross-site Fetch Metadata. Bootstrap may accept cross-site traffic only for a user-activated top-level document navigation; fetch/XHR, iframe, non-user navigation, or conflicting Origin must remain denied.
- Request-target parsing is fail-closed: malformed, absolute-form, scheme-relative, or normalization-trick targets must not escape the opaque deny surface.
- Unauthenticated HTTP responses are intentionally indistinguishable where an HTTP response can be emitted, including parser errors.
- Bootstrap is reserved only for the literal `/?token=...` request target; application query parameters named `token` on other paths remain application-owned.
- Session cookies are `Secure` by default. Disabling `secureCookie` is an explicit local-development choice.
- The bootstrap token and gateway session cookie must never be proxied to DSH, and upstream responses must not overwrite the gateway cookie namespace.
- HTTP and WebSocket paths share the same access policy.
- WebSocket hop-by-hop headers are reconstructed by the gateway; do not forward arbitrary client `Connection` tokens.
- Upstream abort/error paths must terminate downstream responses and sockets; partial responses must not hang indefinitely.
- Cordis activation awaits gateway listen, acquisition failure cleans up partial gateway state, and disposal awaits listener plus owned HTTP/WebSocket socket shutdown.
- Rate-limit identities and sessions have hard cardinality bounds without global capacity lockout; bounded state uses eviction rather than refusing every new identity/session.
- A valid bootstrap token is an administrator credential. Authenticated loopback rewriting intentionally grants that credential the DSH control surface described in `SECURITY.md`.

## Validation

Run `pnpm run typecheck`, `pnpm run test:coverage`, `pnpm run build`, and `npm pack --dry-run` before release-facing changes. Security-boundary changes should include both isolated regressions and, where lifecycle/proxy semantics are involved, real Cordis or raw-socket integration coverage.
