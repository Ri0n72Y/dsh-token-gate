# Changelog

## 0.3.0 - Unreleased

### Security

- Remove implicit loopback bypass and require the DSH upstream web server to remain bound to `127.0.0.1`.
- Default the gateway itself to `127.0.0.1`; direct `0.0.0.0` listening now requires explicit configuration.
- Make trusted proxies explicit and resolve `X-Forwarded-For` from the right through the trusted chain; provider-specific real-IP modes are no longer part of the gateway surface.
- Bind sessions to the authority used during bootstrap and apply the Host/Origin/Fetch-Metadata browser-trust checks to bootstrap as well as authenticated traffic.
- Require IP allowlist bypasses to pass a Host fence; named authorities must be declared in `trustedHosts`.
- Replace the script-bearing 404/bootstrap API with a root-only query-token exchange and a uniform opaque 404 response.
- Keep the gateway session cookie `HttpOnly; Secure; SameSite=Lax`, strip it before forwarding to DSH, and filter same-name upstream `Set-Cookie` responses.
- Strip external proxy-identity and hop-by-hop headers; WebSocket upgrades rebuild only the required `Connection: Upgrade` / `Upgrade` pair.
- Bound both rate-limit identity state and active session state.
- Compare bootstrap tokens through fixed-size SHA-256 digests and validate configured cookie names.
- Fail closed when no bootstrap token is configured unless generated-token development mode is explicitly enabled.

### Engineering

- Split the gateway into config, network, access, auth, proxy, upstream, gateway lifecycle, and Cordis entry modules.
- Make Cordis activation/disposal await listen and close, so listen failures fail the fiber and HMR waits for teardown.
- Contain malformed request targets and unexpected request-handler exceptions to the affected request/socket instead of allowing them to escape the Node server callback.
- Terminate downstream HTTP responses when the DSH upstream aborts mid-body.
- Correct WebSocket proxy semantics for non-101 responses, sanitized upgrade headers, upstream cookie ownership, and early `head` bytes.
- Replace the monolithic smoke script with Node test-runner unit/integration regressions and coverage gates.
- Add cross-platform CI and npm package metadata.
