# Verification Specification

This document defines the evidence required for the projected contract in [`system.md`](./system.md). Verification follows the actual impact surface rather than coverage percentage or test count.

## 1. Verification policy

A test or manual acceptance check should protect at least one independently meaningful failure mode:

- a user-observable access behavior;
- durable session state across lifecycle transitions;
- a non-trivial parser/state/protocol rule;
- a reproduced regression;
- a DSH/Cordis lifecycle, storage, HTTP, or WebSocket contract actually depended on.

Do not add fake Cordis/storage implementations merely to claim framework coverage when the important contract can be checked against a real DSH profile.

IP allowlist behavior is not part of the current Requirement and is not a release verification target.

## 2. Required automated evidence

The aligned implementation should keep the smallest regression set that independently protects these surfaces:

| Surface | Required evidence |
|---|---|
| Bootstrap | valid root token creates a session, returns `303`, removes only the gateway token, and denied/application-path requests do not bootstrap |
| Durable session creation | bootstrap success is returned only after the session record is durably written |
| Restart persistence | a cookie issued by one plugin/session-repository instance is accepted by a newly opened instance using the same storage medium |
| Expiry / authority | expired or wrong-authority persisted sessions do not authorize |
| Cookie boundary | gateway cookie is not forwarded to DSH and DSH cannot overwrite the gateway cookie name |
| HTTP proxy | authorized HTTP reaches DSH; upstream abort/error terminates the downstream correctly |
| WebSocket proxy | rejection, acceptance/early data, paired teardown, and gateway disposal preserve expected protocol behavior |
| Upstream invariant | token-gate refuses a DSH Web upstream that is not loopback-only |
| Token resolution | configured/environment/development fallback and missing-token failure behave as specified |

The current pre-alignment test suite may contain extra tests for legacy IP allowlist/client-IP behavior. Those tests are not required by the current Spec and may be removed together with the corresponding implementation surface.

A persistent-session regression is mandatory because R-003 changes a user-observable lifecycle guarantee that the current code does not yet satisfy.

## 3. Repository validation

For release-facing changes on the current target environment:

```sh
pnpm install --frozen-lockfile
pnpm run check
npm pack --dry-run --ignore-scripts
```

Acceptance:

- typecheck succeeds;
- behavior tests succeed;
- build succeeds;
- the publish tarball contains the expected built plugin/bundle artifacts;
- package inspection does not re-run the full build/test lifecycle.

Coverage may be inspected diagnostically but is not a release gate.

## 4. Real DSH Web-profile acceptance

This validates the external DSH/Cordis contracts that should not be replaced by a simulated framework.

### Preconditions

- Windows host;
- Node 22 matching the supported target;
- current DSH CLI on `PATH`;
- usable `web` profile;
- known bootstrap secret;
- DSH Web on loopback;
- Web profile storage capability available.

### A. Install and inspect composition

Install the checkout or release candidate:

```sh
dsh plugin --profile web add .
```

Inspect the composed tree:

```sh
dsh --profile web --dump-config
```

Acceptance:

- token-gate bundle is composed;
- `webServer` remains loopback-only;
- the storage/storage-domain capability required by token-gate is present;
- token-gate listener configuration matches the intended deployment.

### B. Start the Web profile

```sh
dsh web --no-open
```

Acceptance:

- DSH Web and token-gate both start without lifecycle/dependency errors;
- token-gate opens its durable session domain;
- the DSH listener remains distinct and loopback-only.

### C. Unauthorized surface

Access the gateway without a valid session or bootstrap token.

Acceptance:

- the request does not reach DSH;
- HTTP denial uses the documented opaque surface;
- an application path containing its own `token` query does not become a gateway bootstrap.

### D. First bootstrap

Open the configured gateway root with the valid bootstrap token.

Acceptance:

- response is `303`;
- redirected URL no longer contains the gateway token;
- browser receives the HttpOnly session cookie;
- trusted HTTPS ingress produces `Secure`; direct local HTTP does not;
- the corresponding server-side session record has been durably committed before the successful response completes.

### E. Normal DSH use

After bootstrap:

- refresh and navigate DSH Web;
- create/open a DSH conversation;
- perform at least one interaction using the live WebSocket/event path.

Acceptance:

- no repeated bootstrap is required;
- ordinary HTTP and streaming responses work;
- WebSocket/event traffic remains usable;
- DSH application cookies remain usable;
- the token-gate cookie is not forwarded upstream.

### F. Restart persistence

With the browser retaining its session cookie:

1. stop DSH/token-gate cleanly;
2. start the same Web profile again;
3. revisit the gateway without a bootstrap token.

Acceptance:

- the existing cookie still authorizes access;
- the reopened token-gate session domain resolves the persisted record;
- a process/plugin restart alone does not force re-bootstrap.

This is a release-critical acceptance check for R-003.

### G. Expiry

Expiry should be verified through an automated controlled-lifetime/clock/storage fixture rather than waiting for the normal browser TTL in a manual release check.

Acceptance:

- once the server-side expiry is reached, the persisted record no longer authorizes even if a cookie value is still presented;
- cleanup timing may be lazy as long as authorization is denied.

### H. Lifecycle / shutdown

With an active WebSocket/event connection, stop DSH normally.

Acceptance:

- token-gate stops accepting traffic;
- active client sockets close;
- the opened storage-domain handle closes cleanly;
- shutdown does not hang on leaked gateway resources;
- valid persisted session records are not deleted by disposal.

### I. Optional deployment proxy

When a real Caddy/cloudflared deployment is part of the release target, additionally verify trusted HTTPS metadata and remote bootstrap through that path.

Client-IP allowlist behavior is intentionally excluded from this acceptance suite.

## 5. Release decision

A release candidate is ready when:

- repository validation passes on Windows + Node 22;
- the real DSH Web-profile path passes;
- restart persistence passes;
- any Spec/implementation mismatch is resolved explicitly rather than documented as accidental current behavior;
- the published package version matches the artifact actually tested.