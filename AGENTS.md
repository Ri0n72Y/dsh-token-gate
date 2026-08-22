# AGENTS.md

## Scope

This repository is a security boundary in front of DeepSeek Harness. Prefer small, explicit modules and fail-closed behavior.

## Invariants

- DSH upstream must remain bound to `127.0.0.1`; the gateway is the only remote entry.
- There is no implicit loopback bypass; any IP bypass must be explicit in `allowIps`.
- `Host` never grants access by itself: sessions are authority-bound, and IP bypasses must pass the Host fence.
- Forwarded client/protocol headers are ignored unless the socket peer is explicitly listed in `trustedProxies`.
- `X-Forwarded-For` is resolved right-to-left through the trusted-proxy chain; `CF-Connecting-IP` requires explicit `realIpHeader` selection.
- Browser `Origin` and Fetch Metadata are validated before internal Host/Origin rewriting.
- Unauthenticated HTTP responses are intentionally indistinguishable.
- Bootstrap is reserved only for `/?token=...`; application query parameters named `token` on other paths remain application-owned.
- The bootstrap token and gateway session cookie must never be proxied to DSH.
- HTTP and WebSocket paths share the same access policy.
- Cordis activation awaits gateway listen, and disposal awaits gateway socket/listener shutdown.
- Rate-limit identities and sessions have hard cardinality bounds.

## Validation

Run `pnpm run typecheck`, `pnpm run test:coverage`, `pnpm run build`, and `npm pack --dry-run` before release-facing changes.
