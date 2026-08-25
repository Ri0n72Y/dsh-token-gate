# Verification Specification

This document defines how the current token-gate contract is verified. It deliberately separates automated regression tests from target-environment release validation.

## 1. Testing policy

Tests are required when they have independent failure value. A test should protect at least one of:

- user-observable plugin behavior;
- a non-trivial parser, state transition, or bounded-state rule;
- a reproduced regression;
- a DSH/Cordis contract that this plugin actually depends on.

Test count, coverage percentage, CI job count, and platform-matrix size are not quality targets. Coverage is diagnostic only. Fake Cordis implementations are not an acceptable substitute for validating the plugin in a real DSH profile.

## 2. Automated regression suite

The current Node test-runner suite contains 12 behavior-oriented tests.

| Current test | Primary requirements protected |
|---|---|
| `bootstrap creates a session and authorized HTTP requests reach DSH` | TG-AUTH-002, TG-AUTH-003, TG-AUTH-005, TG-ACCESS-001, TG-PROXY-003, TG-PROXY-004, TG-PROXY-005 |
| `session cookie uses Secure only for HTTPS ingress` | TG-SESS-001, TG-NET-001 |
| `configured IP allowlist can bypass the session` | TG-ACCESS-004, TG-ACCESS-005, TG-NET-003 |
| `upstream body abort terminates the downstream response` | TG-PROXY-006 |
| `WebSocket relays rejection, early data, and closes the client on gateway dispose` | TG-WS-003, TG-WS-004, TG-WS-005, TG-LIFE-002 |
| `IpSet handles the address forms used by plugin configuration` | TG-NET-003 |
| `socket address normalization handles IPv4-mapped loopback` | TG-NET-003 |
| `DSH upstream must remain loopback-only` | TG-PROXY-001 |
| `bootstrap owns only the root token query` | TG-AUTH-002 |
| `trusted X-Forwarded-For parsing follows the configured proxy chain` | TG-NET-001, TG-NET-002, TG-NET-003 |
| `rate limiter and session store enforce configured bounds` | TG-SESS-003, TG-RATE-001, TG-RATE-002 |
| `token resolution covers configured, environment, generated, and missing tokens` | TG-AUTH-001 |

This table is a traceability aid, not a requirement for one test per requirement. Some simple invariants are exercised transitively through larger gateway behavior and do not need duplicate helper-level tests.

## 3. Repository validation

For a release-facing change, run on the current target environment (Windows + Node 22):

```sh
pnpm install --frozen-lockfile
pnpm run check
npm pack --dry-run --ignore-scripts
```

Expected result:

- typecheck succeeds;
- all behavior tests succeed;
- build succeeds;
- the publish tarball contains the built plugin, bundle patch, README, license, and package metadata expected by `package.json`;
- no lifecycle script causes the same build/test sequence to run a second time during the script-free tarball inspection.

`pnpm run test:coverage` may be run to inspect blind spots but its percentage is not a release criterion.

## 4. Real DSH Web-profile acceptance test

This check exists because DSH/Cordis integration is an external runtime contract and should not be simulated merely to increase automated coverage.

### Preconditions

- Windows host.
- Node 22 matching the current CI target.
- Current DSH CLI available on `PATH`.
- A usable `web` profile.
- DSH Web server configured/bound to its loopback default.
- A known bootstrap token available through `DSH_AUTH_TOKEN` or private plugin config.

### A. Install the bundle

From the plugin checkout or release-candidate package:

```sh
dsh plugin --profile web add .
```

For a published package, replace `.` with the exact release candidate/package version being validated.

Acceptance:

- installation succeeds;
- DSH recognizes the package as a bundle;
- no build permission workaround is required for a built package/tarball.

### B. Inspect composed configuration

Run:

```sh
dsh --profile web --dump-config
```

Acceptance:

- the token-gate bundle patch appears in the composed tree;
- the `token-gate` row resolves from the installed package;
- DSH Web remains configured for loopback;
- the gateway bind/port match the intended deployment configuration.

This command inspects composition without booting the profile; it is not a runtime test.

### C. Start DSH through the Web profile

Start the profile without automatic browser handoff when useful:

```sh
dsh web --no-open
```

Acceptance:

- DSH Web starts on loopback;
- token-gate reports its own listener;
- there is no `EADDRINUSE` or missing `webServer` failure;
- direct DSH upstream remains distinct from the gateway listener.

### D. Unauthorized surface

Open the gateway without a session and without `?token=`.

Acceptance:

- HTTP response is the opaque plain-text 404;
- repeated denied requests do not expose a login/status endpoint;
- application path queries containing `token` do not trigger bootstrap.

### E. First bootstrap

Open:

```text
http://127.0.0.1:3081/?token=<configured-token>
```

or the configured HTTPS deployment authority.

Acceptance:

- response redirects with `303`;
- redirected URL no longer contains the gateway token;
- browser receives the gateway HttpOnly session cookie;
- local HTTP cookie does not carry `Secure`;
- trusted HTTPS ingress cookie does carry `Secure`.

### F. Authenticated browser use

After bootstrap:

- refresh the DSH page;
- navigate across ordinary DSH Web routes;
- create or open a DSH session/conversation;
- perform at least one interaction that exercises the live WebSocket/event channel.

Acceptance:

- no second bootstrap is required while the plugin instance remains alive;
- ordinary HTTP requests reach DSH;
- DSH application cookies continue to work;
- the gateway session cookie is not visible to DSH as an upstream cookie;
- WebSocket/event traffic remains connected and usable.

### G. Wrong-token and rate behavior

Use a clean browser/client and submit an invalid bootstrap token several times.

Acceptance:

- each failed attempt returns the same opaque 404;
- after the configured per-client attempt limit, further bootstrap attempts in the same window remain denied;
- a denial does not affect an already valid browser session.

### H. Restart semantics

Stop the DSH process cleanly, then start the Web profile again. Revisit the gateway using the browser that still holds the previous cookie.

Acceptance for the current specification:

- the old cookie no longer authorizes access because session state is process-local;
- a fresh valid bootstrap creates a new working session.

If persistent device trust is desired instead, that is a product change to TG-SESS-004 and must be specified before implementation.

### I. Lifecycle / shutdown

With at least one active WebSocket/event connection, stop DSH normally.

Acceptance:

- active gateway client sockets close;
- token-gate disposal settles within DSH's graceful shutdown window;
- the process does not remain alive because of leaked gateway sockets.

### J. Optional reverse-proxy deployment

When validating a real Caddy/cloudflared deployment:

- keep the gateway on loopback unless direct network binding is intentionally required;
- configure only the direct deployment proxy in `trustedProxies` (or the necessary trusted chain);
- ensure the proxy supplies normalized `X-Forwarded-For` and `X-Forwarded-Proto` values;
- use the intended named authority in `trustedHosts` only when IP allowlist bypass requires it.

Acceptance:

- remote HTTPS bootstrap succeeds;
- session cookie carries `Secure`;
- spoofed forwarded headers from an untrusted direct peer do not change the client/protocol identity;
- optional IP allowlist behavior matches the configured client network.

## 5. Release decision

A release candidate is ready for publication when:

- repository validation passes on Windows + Node 22;
- the real DSH Web-profile acceptance test passes for the supported deployment path;
- any observed mismatch is either fixed with a requirement/regression update or explicitly documented as current behavior;
- the package/changelog version being published matches the tested artifact.

Broader OS/runtime support, persistent sessions, logout/session-management UI, additional authentication methods, or CDN-specific adapters are not implicit release blockers for the current scope.