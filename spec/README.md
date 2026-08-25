# Specification Workflow

This repository uses a deliberately small Spec Driven Development workflow:

**Requirement → Architecture/Design → Spec → Task**

The first documentation pass was created after the implementation already existed. That made it easy to accidentally promote current code choices into product requirements. The corrected baseline treats implementation as evidence only and restores authority to the upstream artifacts.

## Authority

### [`requirement.md`](./requirement.md) — intent authority

Defines:

- the project goal;
- user-observable outcomes;
- product/environment constraints;
- current non-goals and future directions.

Implementation does not redefine Requirement merely because it already behaves differently.

### [`architecture.md`](./architecture.md) — structural authority

Defines how the Requirement is organized:

- system/component boundaries;
- Cordis/DSH integration points;
- persistence ownership;
- dependency direction;
- lifecycle and data flow;
- C4, data-flow, and UML views.

Material structural decisions belong here before they are projected into Spec.

### [`system.md`](./system.md) — agent-facing Spec

Projects only the Requirement and Architecture details an implementation agent needs in order to act correctly:

- observable behavior;
- owning components;
- contracts and invariants;
- allowed/prohibited change surfaces;
- failure behavior;
- verification obligations.

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

## Current correction

The current authority now says:

- browser bootstrap is one-time until session expiry, not merely until process restart;
- session authorization therefore uses DSH's durable storage-domain capability and survives plugin/process recreation;
- IP allowlist authentication is not a current product requirement and is excluded from core Spec and release verification;
- the gateway remains a minimal DSH Web access gate rather than a general security proxy.

The implementation merged through PR #3 does not yet fully satisfy that authority. In particular, its process-local session Map and current IP-allowlist surface are implementation deltas to be corrected in downstream work.