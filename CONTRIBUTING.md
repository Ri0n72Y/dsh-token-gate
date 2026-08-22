# Contributing

Keep changes small and scoped to the DSH plugin contract.

Before opening a PR, run:

```sh
pnpm install
pnpm run check
npm pack --dry-run --ignore-scripts
```

Add a regression test when a change affects observable plugin behavior, a non-trivial parsing/state rule, or fixes a reproduced bug. Avoid duplicate unit/integration checks for the same invariant, fake framework implementations, and tests added only to raise coverage numbers.

`pnpm run test:coverage` is available as a diagnostic report. Coverage percentage is not a release gate.

The current development validation target is Windows with Node 22. Add another platform or runtime lane only when the plugin actually supports it as a target or a concrete platform-specific regression justifies the extra CI cost.
