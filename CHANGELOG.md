# Changelog

## 0.3.0 - Unreleased

### Security

- Require both loopback TCP peer and loopback Host for local bypass, closing the Host-header spoof path.
- Trust forwarded client/protocol headers only from configured trusted proxies.
- Replace the script-bearing 404/bootstrap API with a server-side query-token exchange and a uniform opaque 404 response.
- Strip the gateway session cookie before forwarding traffic to DSH.
- Add IPv6-aware IP/CIDR matching and stricter proxy header handling.
- Fail closed when no bootstrap token is configured unless generated-token development mode is explicitly enabled.

### Engineering

- Split the gateway into config, network, access, auth, proxy, gateway lifecycle, and Cordis entry modules.
- Replace the monolithic smoke script with Node test-runner unit/integration regressions and coverage gates.
- Add cross-platform CI and npm package metadata.
