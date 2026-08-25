# Product Requirement

Status: **current intent authority**

## Goal

`dsh-token-gate` gives DSH Web a minimal host-controlled browser entry point without requiring DSH itself to be exposed or modified.

A remote browser presents a configured bootstrap secret to request device authorization. The host approves that device from a simple local management surface. Once approved, the browser receives a durable session and then uses DSH's existing HTTP and WebSocket surfaces transparently while the device remains authorized and active.

The product is an **access gate for DSH Web**, not an identity platform, general reverse proxy, firewall, or WAF.

## Core requirements

### R-001 — Keep DSH private

DSH Web must remain reachable only through its loopback listener. Remote/browser-facing access goes through the token-gate listener or through a deployment proxy that forwards to token-gate.

The host may use the loopback DSH Web surface directly for local administration.

### R-002 — Token starts device authorization

Possession of the configured bootstrap secret is necessary to request access, but does not by itself grant DSH access.

A valid root bootstrap request must create or resume a pending device-authorization request and remove the bootstrap secret from the visible URL before waiting for approval.

By default, the remote browser does not receive a DSH-authorizing session until the host approves that device.

After approval:

- the browser receives an HttpOnly session cookie;
- ordinary navigation no longer requires the bootstrap secret;
- the approved device appears in the host's authorized-device list.

A revoked or expired device must use a bootstrap-secret link again and pass host approval again before regaining access.

### R-003 — Durable sliding session

An approved browser session must survive DSH/token-gate process restart or plugin recreation.

Session lifetime is **sliding** rather than a fixed deadline from first approval. Successful use refreshes the inactivity deadline. The implementation may coalesce refreshes so durable state and the browser cookie are renewed no more than necessary; the expected default is to renew on the first successful request after roughly one day rather than writing on every request.

As long as the device remains authorized and continues to be used within the configured session lifetime, ordinary process restart must not force re-authorization.

Expiry remains authoritative: an expired browser cookie, expired durable authorization, missing durable record, or revoked device must not authorize access.

### R-004 — Host can see and manage devices

The host must have a simple management surface available from the local DSH Web environment.

It must show at least:

- pending device-authorization requests;
- currently authorized devices;
- enough metadata to distinguish devices, such as a device label/browser description plus created/last-seen/expiry information.

The host must be able to:

- approve or reject a pending device request;
- revoke an authorized device;
- observe the device's current authorization state.

Revocation must invalidate that device's existing login state. Revocation does not permanently ban the device: it may later present the bootstrap secret and request host authorization again.

The device list and approval controls are a host-administration surface, not a public remote management application.

### R-005 — Transparent DSH use after authorization

Once authorized, the user should be able to use DSH Web as if connected directly to it:

- ordinary HTTP requests and streaming responses work;
- DSH WebSocket/event traffic works;
- application-owned cookies and application query parameters continue to behave normally.

The gateway must not require knowledge of DSH agents, conversations, tools, skills, UI routes, or other application internals.

### R-006 — Unauthorized access is denied at the gate

Requests without an approved, valid device session must not reach DSH.

Before approval, a browser that has presented a valid bootstrap secret may see only the minimal pairing/waiting surface required to complete host authorization. Invalid bootstrap attempts and unrelated unauthorized traffic should retain a small opaque denial surface.

### R-007 — Fit the DSH/Cordis runtime

The plugin should use existing DSH/Cordis extension points for lifecycle, Web-server discovery, durable storage, and Web client extension rather than introducing a parallel host framework.

Activation and disposal must compose with Cordis lifecycle semantics, and normal shutdown must not be held open by leaked gateway connections.

The host device-management UI should integrate into DSH Web as a plugin-owned client/settings surface rather than running a separate administration web application.

## Product constraints

- The current validated target is Windows + Node 22.
- TLS termination is deployment infrastructure responsibility; token-gate may sit behind Caddy, cloudflared, or another trusted local proxy.
- The upstream DSH Web server remains on loopback.
- Authorization persistence must be local and lightweight; running a separate database service is not a product requirement.
- Session refresh should avoid unnecessary durable writes; activity may be coalesced to approximately one refresh per day per active device.
- Tests and CI remain proportional to the actual impact surface; coverage percentage, test count, and platform-matrix size are not quality goals.

## Out of scope

The current product does not require:

- usernames/passwords, OAuth, OIDC, or external identity providers;
- multiple users, roles, permissions, or account administration beyond device approval/revocation;
- IP allowlist authentication;
- CDN/vendor-specific client-IP adapters;
- TLS certificate management;
- a general-purpose reverse-proxy configuration surface;
- a firewall or WAF.

## Future directions

The following may be added only when a concrete use case justifies them:

- IP/network allowlist access;
- explicit per-device naming/editing beyond the minimal distinguishing metadata;
- multiple bootstrap credentials or user identities;
- alternate authentication methods;
- additional deployment-proxy integrations.

These are not current acceptance requirements and should not drive implementation or test scope until promoted into Requirement.