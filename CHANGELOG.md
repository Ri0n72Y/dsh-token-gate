# Changelog

## 0.3.0 - Unreleased

### Security

- Remove implicit loopback bypass and require the DSH upstream web server to remain bound to `127.0.0.1`.
- Make trusted proxies explicit; resolve `X-Forwarded-For` from the right through the trusted chain and require explicit opt-in for `CF-Connecting-IP`.
- Bind sessions to the authority used during bootstrap and restore Host/Origin/Fetch-Metadata browser-trust checks before proxy rewriting.
- Require IP allowlist bypasses to pass a Host fence; named authorities must be declared in `trustedHosts`.
- Replace the script-bearing 404/bootstrap API with a root-only query-token exchange and a uniform opaque 404 response.
- Strip gateway cookies and proxy-identity headers before forwarding traffic to DSH, and strip hop-by-hop response headers.
- Bound both rate-limit identity state and active session state.
- Compare bootstrap tokens through fixed-size SHA-256 digests and validate configured cookie names.
- Fail closed when no bootstrap token is configured unless generated-token development mode is explicitly enabled.

### Engineering

- Split the gateway into config, network, access, auth, proxy, upstream, gateway lifecycle, and Cordis entry modules.
- Make Cordis activation/disposal await listen and close, so listen failures fail the fiber and HMR waits for teardown.
- Correct WebSocket proxy semantics for non-101 responses and early `head` bytes.
- Replace the monolithic smoke script with Node test-runner unit/integration regressions and coverage gates.
- Add cross-platform CI and npm package metadata.
