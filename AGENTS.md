# AGENTS.md

## Scope

`dsh-token-gate` is a minimal host-controlled browser entry point in front of DSH Web. It should remain smaller than a general authentication platform, reverse proxy, firewall, or WAF.

## Spec Driven Development

Use the repository artifacts in this authority order:

1. `spec/requirement.md` — product intent and acceptance direction.
2. `spec/architecture.md` — structural design, ownership, dependencies, persistence, lifecycle, and data flow.
3. `spec/system.md` — agent-facing implementation contract projected from Requirement + Architecture.
4. development Tasks — concrete implementation decomposition built from all three.
5. implementation — evidence of current state, not authority over the layers above it.

If code and Spec disagree, do not rewrite upstream intent merely to match existing code. Find the earliest incorrect/incomplete authority layer and propagate the correction downward.

## Core architectural invariants

- DSH Web remains bound to loopback; token-gate is the remote browser-facing entry boundary.
- A bootstrap secret starts a **pending device-authorization request**; possession of the secret alone does not grant DSH access.
- The bootstrap secret is removed from the visible URL before the browser waits for host approval.
- The host approves/rejects pending devices and revokes authorized devices through a simple local DSH Web client/settings surface.
- Only an approved device receives a long-lived authorizing session.
- Authorized device state survives plugin/process recreation and uses the DSH/Cordis storage-domain capability rather than a parallel persistence framework.
- Device sessions use sliding inactivity expiry; renewal is coalesced to roughly the first valid request after one day instead of writing durable state on every request.
- Host revocation invalidates the current session; the device may pair again only through bootstrap token + new host approval.
- Authorized HTTP and WebSocket traffic stays transparent to DSH application behavior.
- Gateway pairing/session credentials do not leak upstream to DSH.
- HTTP and WebSocket share the same device authorization contract.
- Cordis activation/disposal owns listener, connection, and opened-authorization-domain lifecycle.
- IP allowlist authentication is not part of the current product Requirement. Do not expand or test that surface unless Requirement is changed first.

## Testing discipline

- Add tests only when they protect user-observable pairing/access behavior, durable authorization/lifecycle transitions, sliding-expiry/revocation state logic, non-trivial protocol logic, reproduced regressions, or real DSH/Cordis contracts.
- Do not simulate Cordis/storage/client-runtime internals merely to claim framework integration coverage when a real DSH Web profile is the meaningful contract.
- Do not duplicate the same invariant at multiple test layers without independent failure value.
- Coverage percentage, test count, CI job count, and platform-matrix size are diagnostic/operational choices, not quality goals.
- The current supported validation target is Windows + Node 22; broaden it only for a real support target or reproduced platform-specific issue.

## Validation

For release-facing changes run:

```sh
pnpm run check
npm pack --dry-run --ignore-scripts
```

For DSH/Cordis/storage/client integration changes, also run the real Web-profile acceptance flow in `spec/verification.md`.
