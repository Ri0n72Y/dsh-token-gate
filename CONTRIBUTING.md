# Contributing

Changes to `dsh-token-gate` should preserve its small security surface.

Before opening a PR, run:

```sh
pnpm install
pnpm run typecheck
pnpm run test:coverage
pnpm run build
npm pack --dry-run
```

Security-sensitive changes need regression tests. In particular, changes involving Host handling, forwarded headers, cookie forwarding, bootstrap URLs, WebSocket upgrades, or lifecycle cleanup must demonstrate both the allowed and denied path.

Do not add a new public auth/status endpoint unless its information disclosure is explicitly justified. Unauthenticated probes should continue to receive the same 404 response.
