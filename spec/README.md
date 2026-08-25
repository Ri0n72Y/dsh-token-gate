# Specification Workflow

This repository uses a deliberately small Spec Driven Development workflow:

**Requirement → Architecture/Design → Spec → Task**

The first documentation pass was created after implementation already existed, which made it easy to promote current code choices into product requirements. The corrected baseline treats implementation as evidence only and restores authority to upstream artifacts.

## Authority

### [`requirement.md`](./requirement.md) — intent authority

Defines the project goal, user-observable outcomes, product/environment constraints, current non-goals, and future directions.

Implementation does not redefine Requirement merely because it already behaves differently.

### [`architecture.md`](./architecture.md) — structural authority

Defines how the Requirement is organized: system/component boundaries, DSH/Cordis integration points, persistence ownership, dependency direction, lifecycle/data flow, and C4/UML views.

Material structural decisions belong here before they are projected into Spec.

### [`system.md`](./system.md) — agent-facing Spec

Projects only the Requirement and Architecture details an implementation agent needs: observable behavior, owning components, contracts/invariants, failure behavior, and verification obligations.

Spec must not invent a new product or architecture decision.

### [`verification.md`](./verification.md) — verification projection

Defines the smallest evidence needed for the real affected surfaces. Test count, coverage percentage, CI job count, and platform-matrix size are not goals.

## Change workflow

For a behavior-changing change:

1. update Requirement if product intent changed;
2. update Architecture when ownership, state, data flow, lifecycle, or another material structural choice changed;
3. re-project only the affected Spec obligations;
4. build implementation Tasks from Requirement + Architecture + Spec;
5. implement and verify against those artifacts.

If implementation reveals a mismatch, repair the earliest authoritative layer that is actually wrong. Do not silently edit Requirement/Architecture to make existing code look correct.

## Current authority

The current authority says:

- a bootstrap token starts a **device authorization request**; it does not immediately grant DSH access;
- the host approves/rejects pending devices and can revoke existing devices from a simple local DSH Web management surface;
- authorized device sessions are durable across process recreation;
- session expiry is sliding with use, with durable renewal coalesced to roughly the first request after one day rather than every request;
- revocation invalidates the current session, but the device may later pair again through token + host approval;
- IP allowlist authentication is not a current product requirement;
- the gateway remains a minimal DSH Web access gate rather than a general security proxy.

The implementation merged through PR #3 does not yet fully satisfy that authority. Its immediate token-to-session flow, process-local session Map, fixed expiry, absent device-management client surface, and IP-allowlist machinery are implementation deltas to be corrected downstream.