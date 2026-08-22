# AGENTS.md

## Scope

This repository is a small authentication/reverse-proxy boundary in front of DeepSeek Harness. Keep changes scoped to the DSH plugin contract: prefer small, explicit modules, fail-closed behavior, and provider-neutral proxy semantics over adding general-purpose network-security features.

## Invariants

- DSH upstream must remain bound to `127.0.0.1`; the gateway is the only entry presented to clients.
- The gateway itself defaults to `127.0.0.1`; `0.0.0.0` listening must be an explicit deployment choice.
- There is no implicit loopback bypass; any IP bypass must be explicit in `allowIps`.
- `Host` never grants access by itself: sessions are authority-bound, and IP bypasses must pass the Host fence.
- Forwarded client/protocol headers are ignored unless the socket peer is explicitly listed in `trustedProxies`.
- Real client IP is either direct TCP peer (`realIpHeader=none`) or `X-Forwarded-For` resolved right-to-left through the trusted-proxy chain. Do not add provider-specific real-IP modes; normalize them at the deployment proxy instead.
- Browser `Origin` and Fetch Metadata are validated before internal Host/Origin rewriting, including bootstrap requests.
- Unauthenticated HTTP responses are intentionally indistinguishable.
- Bootstrap is reserved only for `/?token=...`; application query parameters named `token` on other paths remain application-owned.
- The bootstrap token and gateway session cookie must never be proxied to DSH.
- The gateway session cookie remains `HttpOnly; SameSite=Lax`; add `Secure` only when the trusted request boundary reports HTTPS. Upstream `Set-Cookie` with the same cookie name must not overwrite it.
- Request/response hop-by-hop headers are stripped. WebSocket forwarding rebuilds only the required `Connection: Upgrade` / `Upgrade` pair.
- Malformed request targets and unexpected request-handler failures stay scoped to the affected request/socket; an upstream body abort must terminate the corresponding downstream response.
- HTTP and WebSocket paths share the same access policy.
- Cordis activation awaits gateway listen, and disposal does not resolve until the gateway listener and all tracked client sockets, including upgraded sockets, have closed.
- Rate-limit identities and sessions have hard cardinality bounds.

## Validation

Run `pnpm run typecheck`, `pnpm run test:coverage`, `pnpm run build`, and `npm pack --dry-run` before release-facing changes. Transport and lifecycle changes should include both allowed and denied/error-path regressions. CI covers the Node 22 floor on Linux and Windows plus Node 24 on Linux.
