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

## Testing discipline

- Tests protect observable plugin behavior, non-trivial parsing/state rules, or a reproduced regression.
- Do not simulate Cordis internals with fake `Context`/`effect` implementations merely to claim framework integration coverage.
- Do not duplicate the same invariant at unit, integration, and framework layers unless each layer catches a distinct failure mode.
- Coverage reports are diagnostic only. Never add tests, branches, fixtures, platform jobs, or production code solely to reach a percentage target.
- Platform matrices must follow the plugin's actual supported/tested environment. The current development target is Windows with Node 22; broader matrices require a concrete platform-specific reason.

## Validation

For release-facing changes run `pnpm run check` and `npm pack --dry-run --ignore-scripts`. `pnpm run test:coverage` may be used to inspect blind spots, but its percentage is not a release gate. Add regression tests only when they protect behavior affected by the change.
