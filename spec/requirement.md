# Product Requirement

Status: **current intent authority**

## Goal

`dsh-token-gate` gives DSH Web a minimal authenticated browser entry point without requiring DSH itself to be exposed or modified.

A user should bootstrap access once with a configured secret, receive a browser session, and then use DSH's existing HTTP and WebSocket surfaces transparently until that session expires.

The product is an **access gate for DSH Web**, not an identity platform, general reverse proxy, firewall, or WAF.

## Core requirements

### R-001 — Keep DSH private

DSH Web must remain reachable only through its loopback listener. Remote/browser-facing access goes through the token-gate listener or through a deployment proxy that forwards to token-gate.

### R-002 — One-time browser bootstrap

A user with the configured bootstrap secret can exchange it once for a browser session.

After successful bootstrap:

- the secret is removed from the visible URL;
- ordinary navigation no longer requires the secret;
- the browser holds an HttpOnly session cookie.

### R-003 — Session survives process restart

A valid browser session remains usable until its configured expiry even when the DSH/token-gate process is restarted or the plugin instance is recreated.

The server-side session record therefore must outlive one Node/Cordis process lifetime.

Expiry remains authoritative: a browser cookie that is expired, or whose persisted server-side session is expired or absent, must not authorize access.

### R-004 — Transparent DSH use after authorization

Once authorized, the user should be able to use DSH Web as if connected directly to it:

- ordinary HTTP requests and streaming responses work;
- DSH WebSocket/event traffic works;
- application-owned cookies and application query parameters continue to behave normally.

The gateway must not require knowledge of DSH agents, conversations, tools, skills, UI routes, or other application internals.

### R-005 — Unauthorized access is denied at the gate

Requests without a valid session or valid bootstrap must not reach DSH.

The gateway should expose a small denial surface and should not introduce a separate public login/status application merely to report authentication state.

### R-006 — Fit the DSH/Cordis runtime

The plugin should use existing DSH/Cordis extension points for lifecycle, Web-server discovery, and durable storage rather than introducing a parallel host framework.

Activation and disposal must compose with Cordis lifecycle semantics, and normal shutdown must not be held open by leaked gateway connections.

## Product constraints

- The current validated target is Windows + Node 22.
- TLS termination is deployment infrastructure responsibility; token-gate may sit behind Caddy, cloudflared, or another trusted local proxy.
- The upstream DSH Web server remains on loopback.
- Session persistence must be local and lightweight; running a separate database service is not a product requirement.
- Tests and CI remain proportional to the actual impact surface; coverage percentage, test count, and platform-matrix size are not quality goals.

## Out of scope

The current product does not require:

- usernames/passwords, OAuth, OIDC, or external identity providers;
- multiple users, roles, permissions, or account administration;
- a login UI or session-management dashboard;
- IP allowlist authentication;
- CDN/vendor-specific client-IP adapters;
- TLS certificate management;
- a general-purpose reverse-proxy configuration surface;
- a firewall or WAF.

## Future directions

The following may be added only when a concrete use case justifies them:

- IP/network allowlist access;
- explicit logout or session revocation controls;
- multiple bootstrap credentials or user identities;
- alternate authentication methods;
- additional deployment-proxy integrations.

These are not current acceptance requirements and should not drive implementation or test scope until promoted into Requirement.