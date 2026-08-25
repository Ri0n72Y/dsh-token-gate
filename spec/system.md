# Token Gate Implementation Specification

Status: **projection of `requirement.md` and `architecture.md`**

This document is the agent-facing implementation contract. Product intent comes from [`requirement.md`](./requirement.md); structural authority comes from [`architecture.md`](./architecture.md).

## 1. Scope

Implement a minimal authenticated entry point in front of DSH Web.

The plugin owns:

- root-token bootstrap;
- durable browser sessions;
- request authorization;
- HTTP/WebSocket proxying to loopback DSH Web;
- Cordis-managed listener and storage lifecycle.

The plugin does not own TLS termination, user accounts, IP allowlist authentication, or DSH application behavior.

## 2. Required dependencies and ownership

- The plugin MUST inject the DSH `webServer` service and reject activation when the upstream is not loopback-only.
- The plugin MUST consume DSH `storageDomain` for durable session state.
- Session persistence MUST live in a token-gate-owned storage domain; the physical backend remains host/profile owned.
- Proxy transport MUST NOT contain authentication policy beyond consuming an allow/deny decision.

## 3. Bootstrap contract

### TG-BOOT-001 — Token source

A non-empty configured token or `DSH_AUTH_TOKEN` MUST provide the bootstrap secret. Development-only generated-token fallback MAY remain available when explicitly enabled. Activation MUST fail when no usable secret exists.

### TG-BOOT-002 — Bootstrap ownership

Only a `GET` request to the root path with a non-empty `token` query parameter is a gateway bootstrap request. Application-path query parameters named `token` remain DSH-owned.

### TG-BOOT-003 — Successful bootstrap

A valid bootstrap MUST:

1. create an opaque session bearer;
2. persist its server-side session record before success is returned;
3. bind the record to the external request authority and an expiry timestamp;
4. set an HttpOnly, `SameSite=Lax`, `Path=/` cookie with matching lifetime;
5. add `Secure` when the trusted request boundary reports HTTPS;
6. return `303` to the same URL with only the gateway bootstrap token removed.

If durable session creation fails, bootstrap MUST fail rather than returning a cookie that cannot survive restart.

## 4. Durable session contract

### TG-SESS-001 — Persistent record

The durable session record MUST contain at least:

- external authority;
- absolute expiry time.

The raw cookie bearer SHOULD NOT need to be persisted; repository lookup SHOULD use a stable one-way derived key.

### TG-SESS-002 — Restart survival

A session that has not expired MUST remain valid after DSH/token-gate process restart or plugin recreation, provided its durable record still exists.

Closing the token-gate storage-domain handle MUST release runtime resources without deleting valid session records.

### TG-SESS-003 — Expiry and authority

A request MUST be denied when the persisted session is absent, expired, or bound to a different external authority.

Expiry enforcement is required; physical cleanup of expired records MAY be lazy.

### TG-SESS-004 — Cookie isolation

The gateway session cookie MUST be consumed by token-gate and stripped before forwarding to DSH. DSH responses MUST NOT be allowed to overwrite the gateway-owned cookie name; unrelated application cookies remain intact.

## 5. Access contract

### TG-ACCESS-001 — Denial

Requests that are neither a successful bootstrap nor backed by a valid session MUST NOT reach DSH.

Denied HTTP traffic MUST use the same small opaque denial surface. Denied WebSocket upgrades MUST close/reject without introducing a separate public authentication/status API.

### TG-ACCESS-002 — Browser boundary

Before internal Host/Origin rewriting, the gateway MUST validate the external request authority and MUST reject clearly cross-site browser requests. When an HTTP(S) `Origin` is present, its authority MUST match the external request authority.

Client IP is not part of the current authorization contract.

## 6. Proxy contract

### TG-PROXY-001 — Upstream

DSH Web MUST remain bound to `127.0.0.1`; token-gate uses that injected listener as its upstream.

The gateway listener SHOULD default to loopback. Direct network binding is an explicit deployment choice.

### TG-PROXY-002 — HTTP

Authorized HTTP requests MUST be forwarded as streaming requests/responses. Gateway-owned credentials and hop-by-hop transport headers MUST not leak across the proxy boundary. Internal `Host`/`Origin` values MUST be rewritten to the loopback DSH authority as required by DSH Web.

Upstream failure after response start MUST terminate the downstream response rather than leave it hanging.

### TG-PROXY-003 — WebSocket

Authorized WebSocket upgrades MUST use the same authorization decision as HTTP. Upgrade headers MUST be canonicalized, non-101 upstream responses MUST be relayed as ordinary HTTP, early client bytes MUST not be sent upstream before acceptance, and either-side closure/error MUST tear down the paired connection.

## 7. Lifecycle contract

### TG-LIFE-001 — Activation

Activation MUST open the token-gate session domain and wait for the gateway listener to become ready. Acquisition failure MUST fail plugin activation.

### TG-LIFE-002 — Disposal

Disposal MUST stop accepting new gateway traffic, close tracked client connections including upgraded sockets, close the opened session-domain handle, and resolve only after owned runtime resources have settled.

Durable session records MUST remain available to the next plugin/process instance.

## 8. Configuration surface

The intended core configuration is limited to:

- bootstrap secret source;
- cookie name and session lifetime;
- gateway bind/port;
- trusted transport metadata needed to distinguish trusted HTTPS ingress when a deployment proxy is used;
- explicit development-only generated-token fallback.

Legacy configuration related to IP allowlist/client-IP authorization is not part of the current product contract and may be removed during implementation alignment.

## 9. Failure behavior

- Missing required DSH/Cordis services: fail activation.
- DSH upstream exposed beyond loopback: fail activation.
- Durable session domain cannot open: fail activation.
- Bootstrap secret invalid or durable write fails: deny bootstrap.
- Session missing/expired/authority mismatch: deny request.
- Unexpected per-request proxy failure: contain it to the affected request/socket when possible rather than intentionally terminating DSH.

## 10. Verification obligations

Verification MUST establish at least:

- valid bootstrap persists a session before returning success;
- the same cookie remains authorized after process/plugin restart and stops authorizing after expiry;
- unauthorized traffic does not reach DSH;
- HTTP and WebSocket DSH behavior remains usable through the gate;
- gateway credentials are not forwarded upstream;
- Cordis disposal closes owned connections without deleting durable sessions;
- the plugin works in a real Windows + Node 22 DSH Web profile.

Verification scope is driven by these behaviors and architectural contracts, not by test count or coverage percentage.