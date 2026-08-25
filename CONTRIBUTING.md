# Contributing

Keep changes small and scoped to the DSH access-gate product.

## Spec Driven Development

For behavior-changing work, use:

**Requirement → Architecture/Design → Spec → Task**

- Change `spec/requirement.md` only when product intent, scope, constraints, or acceptance direction changes.
- Change `spec/architecture.md` when ownership, dependencies, persistence, lifecycle, trust boundaries, or data flow materially change.
- Re-project affected implementation obligations into `spec/system.md`; do not invent new product/design decisions there.
- Build implementation Tasks from Requirement + Architecture + Spec.
- Treat existing code as implementation evidence, not authority to redefine the upstream artifacts.

Update only the affected artifacts. Do not regenerate every document for routine patches.

## Validation

Before opening a release-facing PR, run:

```sh
pnpm install
pnpm run check
npm pack --dry-run --ignore-scripts
```

When a change affects DSH/Cordis/storage integration, also follow the relevant real-profile checks in `spec/verification.md`.

## Testing discipline

Add a regression test when it protects observable behavior, durable state/lifecycle transitions, non-trivial protocol/state logic, a reproduced bug, or a real host contract.

Avoid duplicate tests, fake framework implementations, and tests added only to raise coverage numbers. `pnpm run test:coverage` is diagnostic only.

The current validation target is Windows + Node 22. Add another platform/runtime lane only for a real support target or concrete platform-specific regression.