# Changelog

## 0.3.0 - Unreleased

### Product / specification

- Define the product as a minimal host-controlled browser access gate for DSH Web rather than a general security proxy.
- Restore the SDD authority order: Requirement → Architecture/Design → Spec → Task → Implementation.
- Make the bootstrap token a device-pairing credential rather than immediate DSH access.
- Require host approval before a remote device receives an authorizing browser session.
- Require authorized-device sessions to survive DSH/token-gate process recreation and use sliding inactivity expiry.
- Add host-visible pending/authorized device management with approve, reject and revoke operations.
- Use the existing DSH `storageDomain` capability as the durable authorization seam; the host profile owns the physical backend.
- Remove IP allowlist authentication from the current product Requirement and release-verification scope.

### Device authorization implementation

- Add a durable authorization repository for pending pairings and approved devices.
- Persist pending state before presenting the wait surface, and persist authorized-device state before issuing the session cookie.
- Keep raw pairing/session bearer values out of durable storage; use one-way derived keys and deterministic approved-session derivation so approval retries remain idempotent.
- Add a minimal `/_token-gate/wait` + status exchange for remote pairing without exposing DSH before approval.
- Add sliding session renewal with a configurable coalescing interval; ordinary requests do not write durable state until renewal is due.
- Preserve the old durable deadline when a renewal write fails instead of claiming a longer browser lifetime.
- Serialize session issue, renewal and host revocation through the repository mutation chain so an in-flight exchange/renewal cannot recreate a revoked device.
- Register host-only device management routes on the loopback DSH Web server and block those routes at the remote gateway boundary.
- Add a DSH Web client contribution under Plugins settings for listing, approving, rejecting and revoking devices.
- Expose the approved-but-not-yet-exchanged pairing state in the host device panel instead of presenting it as an ordinary pending request.
- Remove IP allowlist authorization and its obsolete configuration/test surface while retaining trusted-proxy metadata only for HTTPS cookie semantics.
- Remove the legacy peer-keyed bootstrap rate limiter: local reverse proxies collapse remote browsers onto one TCP peer, so that limiter could block every new pairing after unrelated invalid attempts. Any future throttling policy must be introduced from an explicit product requirement rather than inferred client-IP identity.

### Proxy / lifecycle engineering

- Keep DSH upstream on `127.0.0.1` and default the gateway itself to loopback.
- Bind device sessions to the external authority and apply browser Host/Origin/Fetch-Metadata checks before proxy rewriting.
- Reserve pairing ownership for the root token query and use an opaque denial surface for unrelated unauthorized traffic.
- Keep gateway cookies `HttpOnly; SameSite=Lax`, add `Secure` for trusted HTTPS ingress, strip pairing/session cookies before forwarding to DSH, and filter same-name upstream `Set-Cookie` responses.
- Strip external proxy-identity and hop-by-hop headers; WebSocket upgrades rebuild only the required `Connection: Upgrade` / `Upgrade` pair.
- Terminate downstream HTTP responses when the DSH upstream aborts mid-body.
- Preserve WebSocket handling for non-101 responses, sanitized upgrade headers, early `head` bytes and paired teardown.
- Keep Cordis disposal responsible for listener/socket teardown and the opened authorization-domain lifecycle.
- Keep tests focused on observable pairing/session/proxy behavior and non-trivial state transitions; coverage remains diagnostic rather than a release percentage gate.
- Keep CI aligned with the current validated target: Windows + Node 22.
