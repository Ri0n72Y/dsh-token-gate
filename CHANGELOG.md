# Changelog

## 0.3.0 - Unreleased

### Product / specification

- Define the product as a minimal authenticated browser access gate for DSH Web rather than a general security proxy.
- Restore the SDD authority order: Requirement → Architecture/Design → Spec → Task; current implementation is evidence, not authority over the upstream artifacts.
- Require browser sessions to remain valid until expiry across DSH/token-gate process recreation.
- Select the existing DSH `storageDomain` capability as the persistence seam for token-gate sessions; the host profile owns the physical backend.
- Remove IP allowlist authentication from the current product Requirement and release-verification scope; it remains only a possible future direction.
- Record the current process-local session Map and IP-allowlist surface as implementation deltas that still need downstream alignment.

### Security / engineering already implemented

- Keep DSH upstream on `127.0.0.1` and default the gateway itself to loopback.
- Bind sessions to the external authority used during bootstrap and apply browser Host/Origin/Fetch-Metadata trust checks before proxy rewriting.
- Reserve bootstrap ownership for the root token query and use the same opaque denial surface for unauthorized traffic.
- Keep the gateway session cookie `HttpOnly; SameSite=Lax`, add `Secure` for trusted HTTPS ingress, strip it before forwarding to DSH, and filter same-name upstream `Set-Cookie` responses.
- Strip external proxy-identity and hop-by-hop headers; WebSocket upgrades rebuild only the required `Connection: Upgrade` / `Upgrade` pair.
- Contain malformed request targets and unexpected request-handler exceptions to the affected request/socket.
- Terminate downstream HTTP responses when the DSH upstream aborts mid-body.
- Correct WebSocket proxy semantics for non-101 responses, sanitized upgrade headers, upstream cookie ownership, early `head` bytes, and paired teardown.
- Keep the Node test-runner suite focused on observable gateway behavior and non-trivial parser/state rules; coverage output remains diagnostic rather than a release percentage gate.
- Keep CI aligned with the current validated target: Windows + Node 22.
