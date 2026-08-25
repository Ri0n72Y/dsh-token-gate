# Verification Specification

This document defines the evidence required for the projected contract in [`system.md`](./system.md). Verification follows the actual impact surface rather than coverage percentage or test count.

## 1. Verification policy

A test or manual acceptance check should protect at least one independently meaningful failure mode:

- a user-observable pairing/device-access behavior;
- durable authorization state across lifecycle transitions;
- sliding-expiry/revocation state transitions;
- a non-trivial parser/protocol rule;
- a reproduced regression;
- a DSH/Cordis lifecycle, storage, client-extension, HTTP, or WebSocket contract actually depended on.

Do not add fake Cordis/storage/client-runtime implementations merely to claim framework coverage when the important integration can be checked against a real DSH Web profile.

IP allowlist behavior is not part of the current Requirement and is not a release verification target.

## 2. Required automated evidence

The aligned implementation should keep the smallest regression set that independently protects these surfaces:

| Surface | Required evidence |
|---|---|
| Pairing bootstrap | valid root token creates durable pending state, removes the secret from the visible flow, and does **not** authorize DSH before host approval |
| Pairing rejection/expiry | rejected, expired, missing, or consumed pending state cannot create an authorized device |
| Host approval | approval permits exactly one durable authorized-device session exchange |
| Restart persistence | a cookie issued to an approved device is accepted by a newly opened repository instance using the same storage medium |
| Sliding renewal | first valid request after the renewal threshold durably extends expiry and cookie lifetime; requests inside the interval do not perform repeated renewal writes |
| Expiry / authority | expired or wrong-authority device records do not authorize |
| Revocation | durable revoke/delete invalidates the old session on the next request; a new pairing flow can authorize the same browser again |
| Device management | pending/authorized lists and approve/reject/revoke mutations reflect repository state |
| Cookie boundary | gateway cookies are not forwarded to DSH and DSH cannot overwrite the gateway session cookie name |
| HTTP proxy | authorized HTTP reaches DSH; upstream abort/error terminates downstream correctly |
| WebSocket proxy | rejection, acceptance/early data, paired teardown, and gateway disposal preserve expected protocol behavior |
| Upstream invariant | token-gate refuses a DSH Web upstream that is not loopback-only |
| Token resolution | configured/environment/development fallback and missing-token failure behave as specified |

Controlled time/storage fixtures are justified for sliding renewal and expiry because they protect non-trivial state transitions without requiring day-long tests.

The current pre-alignment suite may contain tests for legacy IP allowlist/client-IP behavior. Those tests are not required by the current Spec and may be removed with that implementation surface.

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
- Host and client bundles build when the device-management client surface is introduced;
- the publish tarball contains the expected Host plugin, client bundle, bundle patch, and metadata;
- package inspection does not re-run the full build/test lifecycle.

Coverage may be inspected diagnostically but is not a release gate.

## 4. Real DSH Web-profile acceptance

This validates the DSH/Cordis contracts that should not be replaced by simulated framework internals.

### Preconditions

- Windows host;
- Node 22 matching the supported target;
- current DSH CLI on `PATH`;
- usable `web` profile;
- known bootstrap secret;
- DSH Web on loopback;
- Web profile storage/storage-domain capability available.

### A. Install and inspect composition

```sh
dsh plugin --profile web add .
dsh --profile web --dump-config
```

Acceptance:

- token-gate Host bundle is composed;
- DSH Web remains loopback-only;
- required storage/storage-domain capability is present;
- token-gate listener configuration matches deployment intent;
- when the client surface is implemented, the package exposes the expected DSH Web client contribution.

### B. Start the Web profile and host panel

```sh
dsh web --no-open
```

Acceptance:

- DSH Web and token-gate start without lifecycle/dependency errors;
- token-gate opens its durable authorization domain;
- the DSH listener remains distinct and loopback-only;
- the host can open local DSH Web and see the token-gate device-management card in the intended settings/plugin surface;
- the card shows current pending and authorized-device state.

### C. Unauthorized remote access

Access the token-gate listener from a browser without a valid device session or bootstrap token.

Acceptance:

- the request does not reach DSH;
- unrelated unauthorized HTTP uses the documented opaque denial surface;
- an application path containing its own `token` query does not become a gateway pairing request.

### D. Start a pairing request

Open the configured gateway root with the valid bootstrap token from a clean remote browser.

Acceptance:

- the bootstrap secret is removed from the visible URL/next request flow;
- the browser receives only short-lived pairing state, not a DSH-authorizing device session;
- a pending device request is durably visible in the host management card;
- DSH remains inaccessible from that browser while the request is pending.

### E. Reject a device

From the host management card, reject the pending request.

Acceptance:

- the remote browser cannot convert the rejected pairing state into a DSH session;
- DSH remains inaccessible;
- the rejected request disappears from the actionable pending list or is otherwise clearly non-actionable.

### F. Approve a device

Create a fresh pairing request and approve it from the host management card.

Acceptance:

- approval is durably recorded;
- the remote browser's next pairing poll/request exchanges the approved request for an authorized device session;
- the pending request cannot be exchanged twice;
- the browser receives an HttpOnly session cookie and reaches the clean DSH route;
- the device appears in the authorized-device list with distinguishing metadata and created/last-seen/expiry information.

### G. Normal DSH use

After approval:

- refresh and navigate DSH Web through token-gate;
- create/open a DSH conversation;
- perform at least one interaction using the live WebSocket/event path.

Acceptance:

- no repeated pairing is required;
- ordinary HTTP and streaming responses work;
- WebSocket/event traffic remains usable;
- DSH application cookies remain usable;
- token-gate credential cookies are not forwarded upstream.

### H. Restart persistence

With the approved browser retaining its session cookie:

1. stop DSH/token-gate cleanly;
2. start the same Web profile again;
3. revisit token-gate without a bootstrap token.

Acceptance:

- the existing cookie still authorizes access;
- the reopened authorization domain resolves the durable device record;
- process/plugin restart alone does not force host approval again.

### I. Sliding renewal

Use a controlled automated clock/storage test for exact timing, then confirm the observable behavior in a short real-profile check where practical.

Acceptance:

- valid requests before the renewal threshold do not repeatedly write a new durable expiry;
- the first successful request after the threshold extends the durable expiry by the configured inactivity lifetime;
- the browser cookie lifetime is refreshed only after that durable renewal succeeds;
- `lastSeenAt`/renewal metadata shown to the host advances consistently with the coalesced refresh;
- if renewal persistence fails while the old deadline is still valid, the gateway does not claim a longer expiry than durable state proves.

### J. Host revocation and re-authorization

From the host card, revoke the authorized device.

Acceptance:

- the old session cookie stops authorizing on the next request without restarting DSH;
- the device is no longer shown as authorized;
- presenting the bootstrap secret again creates a new pending request rather than restoring access immediately;
- a new host approval creates a fresh usable session.

### K. Expiry

Verify expiry with a controlled lifetime/clock fixture rather than waiting for normal TTL.

Acceptance:

- once durable expiry is reached, the device no longer authorizes even if a cookie value is still presented;
- a new token + host approval flow is required to regain access;
- cleanup timing may remain lazy as long as authorization is denied.

### L. Lifecycle / shutdown

With an active WebSocket/event connection, stop DSH normally.

Acceptance:

- token-gate stops accepting traffic;
- active client sockets close;
- the authorization-domain handle closes cleanly;
- shutdown does not hang on leaked gateway resources;
- valid pending/device records are not deleted merely by disposal.

### M. Optional deployment proxy

When Caddy/cloudflared or another reverse proxy is part of the release target, additionally verify trusted HTTPS metadata, pairing, session renewal, HTTP, and WebSocket behavior through that path.

Client-IP allowlist behavior remains intentionally excluded.

## 5. Release decision

A release candidate is ready when:

- repository validation passes on Windows + Node 22;
- the real DSH Web-profile host panel + remote pairing path passes;
- approval, restart persistence, sliding renewal, revocation, and re-authorization pass;
- any Spec/implementation mismatch is resolved explicitly;
- the published package version matches the artifact actually tested.