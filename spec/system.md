# Token Gate Implementation Specification

Status: **projection of `requirement.md` and `architecture.md`**

This is the agent-facing implementation contract. Product intent comes from [`requirement.md`](./requirement.md); structural authority comes from [`architecture.md`](./architecture.md).

## 1. Scope

The plugin owns:

- root-token device pairing;
- durable pending and authorized-device state;
- host approval/rejection/revocation operations;
- durable sliding browser sessions;
- request authorization;
- HTTP/WebSocket proxying to loopback DSH Web;
- Cordis-managed listener/storage lifecycle;
- a small DSH Web client/settings surface for host device management.

It does not own TLS termination, user accounts, IP allowlist authentication, or DSH application behavior.

## 2. Required dependencies and ownership

- The Host plugin MUST inject DSH `webServer` and reject activation when the upstream is not loopback-only.
- The Host plugin MUST consume DSH `storageDomain` for durable authorization state.
- Physical storage backend selection remains host/profile owned.
- Host device-management operations MUST own authorization mutations; the browser settings card is presentation only.
- Proxy transport MUST consume an authorization decision and MUST NOT own pairing/device policy.
- The management UI SHOULD use DSH's existing `dsh.client`/settings/client-remote extension surfaces rather than create a standalone admin server.

## 3. Pairing contract

### TG-PAIR-001 — Bootstrap secret

A non-empty configured token or `DSH_AUTH_TOKEN` MUST provide the bootstrap secret. Development-only generated-token fallback MAY remain available when explicitly enabled. Activation MUST fail when no usable secret exists.

### TG-PAIR-002 — Bootstrap ownership

Only a `GET` request to the root path with a non-empty `token` query parameter is a gateway pairing request. Application-path query parameters named `token` remain DSH-owned.

### TG-PAIR-003 — Pending request, not immediate access

A valid bootstrap token MUST NOT directly authorize DSH access.

It MUST create or resume a short-lived pending device-authorization request and remove the bootstrap secret from the visible URL. The remote browser MAY receive a temporary opaque pairing bearer/state sufficient to wait for the host decision.

Pending state MUST be durable before the gateway reports that the request is awaiting host approval.

### TG-PAIR-004 — Approval exchange

Only a host-approved, unexpired pending request MAY be exchanged for an authorized device session.

The exchange MUST durably create the authorized-device record before issuing the long-lived session cookie. The pending request MUST then be consumed or otherwise made unusable for creating additional sessions.

Rejected, expired, missing, or already-consumed pending requests MUST NOT authorize DSH.

## 4. Durable device session contract

### TG-SESS-001 — Persistent authorized-device record

The durable record MUST contain enough state to validate and manage the device, including at least:

- external authority;
- creation time;
- last-seen/last-renewed time;
- absolute current expiry;
- next renewal threshold;
- minimal distinguishing metadata for the host device list.

The raw session bearer SHOULD NOT be persisted. Repository lookup SHOULD use a stable one-way derived key.

### TG-SESS-002 — Restart survival

An unexpired, non-revoked authorized device MUST remain valid after DSH/token-gate process restart or plugin recreation when the durable record still exists.

Closing the storage-domain handle MUST release runtime resources without deleting valid device records.

### TG-SESS-003 — Sliding inactivity expiry

Session lifetime MUST slide forward with successful use.

Authorization MUST always enforce the currently durable expiry. To avoid a durable write on every request, renewal SHOULD be coalesced: by default, the first successful request after approximately 24 hours SHOULD persist a new `expiresAt`, update last-seen/renewal metadata, and refresh the browser cookie lifetime.

When renewal is not yet due, an otherwise valid request MUST NOT require a durable write merely to authorize.

If a renewal write fails while the old durable deadline is still valid, the current request MAY proceed under the old deadline, but no longer expiry/cookie lifetime may be claimed until the durable renewal succeeds.

### TG-SESS-004 — Validation

A request MUST be denied when the device record is absent, expired, revoked/invalidated, or bound to a different external authority.

Physical cleanup of expired records MAY be lazy.

### TG-SESS-005 — Cookie isolation

The gateway session cookie MUST be HttpOnly, `SameSite=Lax`, `Path=/`, and carry the current session lifetime. `Secure` MUST be added for trusted HTTPS ingress.

The gateway cookie MUST be stripped before forwarding to DSH. DSH responses MUST NOT overwrite the gateway-owned cookie name; unrelated DSH cookies remain intact.

## 5. Host device-management contract

### TG-MGMT-001 — Host-visible state

The host management surface MUST show:

- pending device requests;
- authorized devices;
- distinguishing metadata plus created/last-seen/expiry information sufficient to identify active devices.

The management surface MUST be reachable through the host's local DSH Web environment and MUST NOT require exposing a separate public administration application.

### TG-MGMT-002 — Host decisions

The host MUST be able to:

- approve a pending request;
- reject a pending request;
- revoke an authorized device.

These operations MUST mutate durable authorization state.

### TG-MGMT-003 — Revocation

Revoking a device MUST invalidate its existing session on subsequent requests without requiring a process restart.

Revocation is not a permanent ban. A revoked device MAY later present the bootstrap secret, create a new pending request, and regain access only after a new host approval.

## 6. Access contract

### TG-ACCESS-001 — DSH access requires authorized device

Only a valid authorized-device session may reach DSH.

A browser with a valid pairing state but no approval may access only the minimal pairing/waiting surface needed to observe host approval/rejection. Invalid bootstrap attempts and unrelated unauthorized traffic MUST NOT reach DSH.

### TG-ACCESS-002 — Browser boundary

Before internal Host/Origin rewriting, the gateway MUST validate the external request authority and reject clearly cross-site browser requests. When an HTTP(S) `Origin` is present, its authority MUST match the external request authority.

Client IP is not part of the current authorization contract.

## 7. Proxy contract

### TG-PROXY-001 — Upstream

DSH Web MUST remain bound to `127.0.0.1`; token-gate uses that injected listener as its upstream. The gateway listener SHOULD default to loopback; direct network binding is an explicit deployment choice.

### TG-PROXY-002 — HTTP

Authorized HTTP requests MUST be streamed to/from DSH. Gateway-owned credentials and hop-by-hop transport headers MUST not leak across the proxy boundary. Internal `Host`/`Origin` MUST be rewritten as required by loopback DSH Web.

Upstream failure after response start MUST terminate the downstream response rather than leave it hanging.

### TG-PROXY-003 — WebSocket

Authorized WebSocket upgrades MUST use the same device authorization decision as HTTP. Upgrade headers MUST be canonicalized; non-101 upstream responses MUST be relayed as ordinary HTTP; early client bytes MUST wait for upstream acceptance; either-side closure/error MUST tear down the paired connection.

## 8. Lifecycle contract

### TG-LIFE-001 — Activation

Activation MUST open the token-gate authorization domain and wait for the gateway listener to become ready. Required service/storage/listener acquisition failures MUST fail plugin activation.

### TG-LIFE-002 — Disposal

Disposal MUST stop accepting new gateway traffic, close tracked client connections including upgraded sockets, close the authorization-domain handle, and resolve only after owned runtime resources settle.

Durable pending/device records MUST not be deleted merely because the plugin/process stops.

## 9. Configuration surface

The intended core configuration is limited to:

- bootstrap secret source;
- gateway and temporary pairing cookie names if separate cookies are used;
- device/session inactivity lifetime;
- renewal interval, defaulting to approximately 24 hours;
- gateway bind/port;
- trusted transport metadata needed to distinguish trusted HTTPS ingress;
- explicit development-only generated-token fallback.

Legacy IP allowlist/client-IP configuration is outside the current product contract and may be removed during implementation alignment.

## 10. Failure behavior

- Missing required DSH/Cordis services: fail activation.
- DSH upstream exposed beyond loopback: fail activation.
- Durable authorization domain cannot open: fail activation.
- Invalid bootstrap secret: deny without creating pending state.
- Pending-state durable write fails: do not report a pending request.
- Device-session durable write fails: do not issue an authorizing cookie.
- Session missing/expired/revoked/authority mismatch: deny DSH access.
- Renewal write fails: retain only the previously durable expiry; do not claim extension.
- Unexpected per-request proxy failure: contain it to the affected request/socket when possible.

## 11. Verification obligations

Verification MUST establish at least:

- valid token creates pending state but cannot access DSH before host approval;
- host approval creates a durable device session and rejection does not;
- the same cookie remains authorized after process/plugin restart;
- the first request after the renewal interval extends durable expiry and cookie lifetime, while requests inside the interval do not require repeated durable writes;
- host revocation invalidates the old cookie and the device can pair again through token + new approval;
- expired/wrong-authority/missing device records are denied;
- the host can list pending and authorized devices through the DSH Web management surface;
- unauthorized traffic does not reach DSH;
- HTTP and WebSocket DSH behavior remains usable through the gate;
- gateway credentials are not forwarded upstream;
- Cordis disposal closes owned resources without deleting durable authorization records;
- the plugin works in a real Windows + Node 22 DSH Web profile.

Verification scope is driven by these behaviors and architectural contracts, not by test count or coverage percentage.