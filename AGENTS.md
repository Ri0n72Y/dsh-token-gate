# AGENTS.md

## Scope

This repository is a security boundary in front of DeepSeek Harness. Prefer small, explicit modules and fail-closed behavior.

## Invariants

- There is no implicit loopback bypass; any IP bypass must be explicit in `allowIps`.
- HTTP `Host` is routing metadata only and must not participate in authorization.
- Forwarded client/protocol headers are trusted only from `trustedProxies`.
- Unauthenticated HTTP responses are intentionally indistinguishable.
- The bootstrap token must never be proxied to DSH.
- The gateway session cookie must never be proxied to DSH.
- HTTP and WebSocket paths share the same access policy.
- Cordis disposal closes gateway-owned sockets and listeners.

## Validation

Run `pnpm run typecheck`, `pnpm run test:coverage`, `pnpm run build`, and `npm pack --dry-run` before release-facing changes.
