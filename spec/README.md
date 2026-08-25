# Specification

This directory is the lightweight specification baseline for `dsh-token-gate`.

The code existed before this specification. This first spec pass therefore records the behavior already implemented on `main`; it does not invent a replacement architecture. After this baseline is merged, behavior-changing work should update the relevant spec first or in the same pull request, then update implementation and tests against that spec.

## Documents

- [`system.md`](./system.md) — product boundary, requirements, invariants, configuration semantics, and non-goals.
- [`architecture.md`](./architecture.md) — C4 views, data-flow view, and UML views of the implemented design.
- [`verification.md`](./verification.md) — automated regression scope and release-candidate validation against a real DSH Web profile.

## Working model

The repository uses a deliberately small form of spec-driven development:

1. **State the observable contract.** Describe the behavior or boundary that should change.
2. **Identify affected requirements.** Add or revise requirement IDs in `system.md` rather than creating a large design process around every patch.
3. **Update architecture only when architecture changes.** Diagrams describe stable relationships and flows; they are not changelog illustrations.
4. **Implement the smallest code change that satisfies the contract.** Existing Cordis and DSH services remain the preferred integration points.
5. **Test according to impact.** Add a regression only when it protects observable behavior, a non-trivial parser/state transition, a reproduced bug, or a DSH/Cordis contract actually depended on.
6. **Validate in the target environment when unit fixtures are insufficient.** Framework simulation is not a substitute for a real DSH Web-profile check.

Coverage percentages, test counts, CI job counts, and platform matrices are not specification requirements.

## Sources of truth

For the baseline represented here:

- `src/` is the implementation fact used to reconstruct the initial specification.
- `spec/` is the intended behavioral contract for future changes.
- `test/` protects selected regressions and non-trivial rules; it is not an exhaustive restatement of the spec.
- `README.md` is user-facing operational documentation and may summarize the spec.
- DSH/Cordis upstream behavior remains external. We document only the contracts this plugin depends on, not simulated copies of framework internals.

If implementation and spec disagree after this baseline, treat the mismatch as something to resolve explicitly in the next change rather than silently editing one side.

## Current scope

The current product is a small authentication/reverse-proxy plugin in front of the DSH Web server. It owns:

- root token bootstrap;
- browser session issuance and validation;
- optional IP allowlist access;
- trusted-proxy client-IP handling;
- HTTP and WebSocket forwarding to the loopback DSH Web server;
- Cordis-managed listener lifecycle.

It does not own TLS termination, user accounts, multi-user authorization, persistent device trust, CDN-specific identity adapters, or a general-purpose network-security layer.

## Baseline status

This spec describes the code merged through PR #3 and the current `0.3.0` unreleased line. The currently validated development target is Windows with Node 22.